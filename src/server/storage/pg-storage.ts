/**
 * PgStorageConnection — adapter PostgreSQL para dataset storage.
 * Usa pg.Pool com conexões persistentes.
 */

import { Pool, type PoolClient, type PoolConfig } from "pg";
import { CW_SYNCED_AT, CW_DELETED_AT, type ColDef, type ColInfo, type StorageConnection } from "./connection";
import { absentFromStaging, carryPlan, missingKeysWhere } from "./delete-detection";

/**
 * Esconde linhas marcadas (cw_deleted_at) de leitores comuns via RLS. Reaplicado a cada swap (DROP TABLE perde a
 * politica). Sem FORCE: o dono (conexao admin do Catworld) continua vendo tudo (rows?since= reporta as marcadas).
 */
async function hideDeletedRows(client: PoolClient, qTable: string): Promise<void> {
  await client.query(`ALTER TABLE ${qTable} ENABLE ROW LEVEL SECURITY`);
  await client.query(`DROP POLICY IF EXISTS cw_hide_deleted ON ${qTable}`);
  await client.query(`CREATE POLICY cw_hide_deleted ON ${qTable} FOR SELECT USING (${pgQuote(CW_DELETED_AT)} IS NULL)`);
}

// ─── URL parsing ──────────────────────────────────────────────────────────────

function parsePgUrl(url: string): PoolConfig {
  const normalized = url.replace(/^postgresql:\/\//, "postgres://");
  const u = new URL(normalized);
  const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.slice(1) || undefined,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: (!ssl || ssl === "disable") ? false : { rejectUnauthorized: ssl === "verify-full" },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 600_000,
  };
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

/** Canonical → Postgres type */
export function canonicalToPg(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return "NUMERIC(18,4)";
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "TIMESTAMP";
  if (sqlType === "TIME") return "TIME";
  return "TEXT"; // NVARCHAR(MAX) e qualquer outro
}

/** Postgres type → canonical */
function pgToCanonical(r: {
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string {
  const dt = r.data_type.toLowerCase();
  if (dt === "bigint" || dt === "integer" || dt === "smallint") return "BIGINT";
  if (dt === "numeric" || dt === "decimal") return `DECIMAL(${r.numeric_precision ?? 18},${r.numeric_scale ?? 4})`;
  if (dt === "date") return "DATE";
  if (dt.startsWith("timestamp")) return "DATETIME2";
  if (dt === "time" || dt.startsWith("time ")) return "TIME";
  return "NVARCHAR(MAX)";
}

// ─── Quoting ──────────────────────────────────────────────────────────────────

export function pgQuote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ─── Pool cache ───────────────────────────────────────────────────────────────

const poolCache = new Map<string, Pool>();

function getPool(id: string, url: string): Pool {
  if (!poolCache.has(id)) {
    const pool = new Pool(parsePgUrl(url));
    pool.on("error", () => { poolCache.delete(id); });
    poolCache.set(id, pool);
  }
  return poolCache.get(id)!;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class PgStorageConnection implements StorageConnection {
  readonly provider = "postgres" as const;
  readonly _pool: Pool;

  constructor(id: string, url: string) {
    this._pool = getPool(id, url);
  }

  q(identifier: string): string {
    return pgQuote(identifier);
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  async createSchemaIfNotExists(schema: string): Promise<void> {
    await this._pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgQuote(schema)}`);
  }

  async dropSchemaIfExists(schema: string): Promise<void> {
    await this._pool.query(`DROP SCHEMA IF EXISTS ${pgQuote(schema)} CASCADE`);
  }

  // ── Tables ──────────────────────────────────────────────────────────────────

  async tableExists(schema: string, table: string): Promise<boolean> {
    const result = await this._pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
       ) AS exists`,
      [schema, table],
    );
    return result.rows[0]?.exists ?? false;
  }

  async createTable(schema: string, table: string, cols: ColDef[]): Promise<void> {
    const colDefs = cols
      .map(c => `${pgQuote(c.name)} ${canonicalToPg(c.sqlType)}${c.nullable ? "" : " NOT NULL"}`)
      .join(", ");
    await this._pool.query(
      `CREATE TABLE ${pgQuote(schema)}.${pgQuote(table)} (${colDefs})`,
    );
  }

  async dropTableIfExists(schema: string, table: string): Promise<void> {
    await this._pool.query(
      `DROP TABLE IF EXISTS ${pgQuote(schema)}.${pgQuote(table)}`,
    );
  }

  async renameTable(schema: string, oldName: string, newName: string): Promise<void> {
    await this._pool.query(
      `ALTER TABLE ${pgQuote(schema)}.${pgQuote(oldName)} RENAME TO ${pgQuote(newName)}`,
    );
  }

  async listTables(schema: string): Promise<string[]> {
    const result = await this._pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema],
    );
    return result.rows.map(r => r.table_name);
  }

  async listColumns(schema: string, table: string): Promise<ColInfo[]> {
    const result = await this._pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table],
    );
    return result.rows.map(r => ({
      name: r.column_name,
      sqlType: pgToCanonical(r),
      nullable: r.is_nullable === "YES",
    }));
  }

  async countRows(schema: string, table: string): Promise<bigint> {
    // Conta so linhas vivas (marcadas como excluidas na origem nao contam); sem a coluna, todas.
    const has = await this._pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, table, CW_DELETED_AT],
    );
    const where = has.rows.length > 0 ? ` WHERE ${pgQuote(CW_DELETED_AT)} IS NULL` : "";
    const result = await this._pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${pgQuote(schema)}.${pgQuote(table)}${where}`,
    );
    return BigInt(result.rows[0]?.n ?? "0");
  }

  // ── Raw SQL ─────────────────────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await this._pool.query(sql);
    return result.rows as T[];
  }

  async execute(sql: string): Promise<number> {
    const result = await this._pool.query(sql);
    return result.rowCount ?? 0;
  }

  /**
   * Executa SQL parametrizado. Usar quando colunas vêm de input externo
   * ou para unnest bulk inserts.
   */
  async queryParams<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this._pool.query(sql, params);
    return result.rows as T[];
  }

  async executeParams(sql: string, params: unknown[]): Promise<number> {
    const result = await this._pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  // ── Bulk insert ──────────────────────────────────────────────────────────────

  /**
   * Bulk insert via unnest() — eficiente para grandes volumes.
   * Cada coluna vira um array $N::text[] que é castado ao tipo destino.
   */
  async bulkInsert(schema: string, table: string, cols: ColDef[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const qTable = `${pgQuote(schema)}.${pgQuote(table)}`;
    const colList = cols.map(c => pgQuote(c.name)).join(", ");
    const params: (string | null)[][] = cols.map(() => []);

    for (const row of rows) {
      for (let j = 0; j < cols.length; j++) {
        const v = row[j];
        params[j]!.push(v == null ? null : String(v));
      }
    }

    const unnestExprs = cols.map((c, i) =>
      `unnest($${i + 1}::text[])::${canonicalToPg(c.sqlType)}`,
    ).join(", ");

    await this._pool.query(
      `INSERT INTO ${qTable} (${colList}) SELECT ${unnestExprs}`,
      params,
    );
  }

  // ── Transactions ─────────────────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  /**
   * Executa fn com um PoolClient dedicado (para transações multi-statement).
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this._pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // ── Atomic swap ───────────────────────────────────────────────────────────────

  async atomicSwap(
    schema: string,
    staging: string,
    target: string,
    cols: ColDef[],
    opts?: { targetExists?: boolean; keyColumn?: string | null; mergedName?: string; fullSnapshot?: boolean; keysTable?: string; keysBefore?: Date },
  ): Promise<{ marked: number }> {
    const qSc = pgQuote(schema);
    const qStg = `${qSc}.${pgQuote(staging)}`;
    const qTgt = `${qSc}.${pgQuote(target)}`;
    const targetExists = opts?.targetExists ?? true;
    const keyColumn = opts?.keyColumn ?? null;
    const fullSnapshot = opts?.fullSnapshot ?? false;
    const qSyncedAt = pgQuote(CW_SYNCED_AT);
    const qDeletedAt = pgQuote(CW_DELETED_AT);

    if (!keyColumn) {
      // Carimba cw_synced_at/cw_deleted_at na staging ANTES do swap — DEFAULT stampa
      // todas as linhas existentes com o mesmo timestamp (now() avaliado uma vez por
      // instrução em Postgres), coerente com "todo o lote foi visto agora".
      // IF NOT EXISTS: staging pode já ter essas colunas numa tentativa anterior — o
      // importer reaproveita a staging (não recria do zero) quando um job de upload é
      // reprocessado após falha parcial (ver comentário de idempotência em importer.ts).
      await this._pool.query(
        `ALTER TABLE ${qStg} ADD COLUMN IF NOT EXISTS ${qSyncedAt} TIMESTAMP NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS ${qDeletedAt} TIMESTAMP NULL`,
      );
      // ── fullSwap: DROP target + RENAME staging → target (transação breve) ──────
      // MVCC: readers que começaram antes do BEGIN continuam vendo a versão antiga.
      const client = await this._pool.connect();
      try {
        await client.query("BEGIN");
        try {
          if (targetExists) await client.query(`DROP TABLE ${qTgt}`);
          await client.query(`ALTER TABLE ${qStg} RENAME TO ${pgQuote(target)}`);
          await hideDeletedRows(client, qTgt);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          await this._pool.query(`DROP TABLE IF EXISTS ${qStg}`).catch(() => {});
          throw e;
        }
      } finally {
        client.release();
      }
      return { marked: 0 };
    }

    // ── mergeSwap: materializa resultado fora de tx (MVCC protege target), depois DDL breve ──
    const mergedName = opts?.mergedName ?? `cw_mgd_${staging.slice(0, 16)}`;
    const qMgd = `${qSc}.${pgQuote(mergedName)}`;
    const key = pgQuote(keyColumn);
    const colDefs = cols
      .map(c => `${pgQuote(c.name)} ${canonicalToPg(c.sqlType)}${c.nullable ? "" : " NOT NULL"}`)
      .join(", ");
    const colList = cols.map(c => pgQuote(c.name)).join(", ");
    const colDefsWithMeta = `${colDefs}, ${qSyncedAt} TIMESTAMP NOT NULL, ${qDeletedAt} TIMESTAMP NULL`;
    const colListWithMeta = `${colList}, ${qSyncedAt}, ${qDeletedAt}`;

    await this._pool.query(`DROP TABLE IF EXISTS ${qMgd}`);

    let marked = 0;

    try {
      await this._pool.query(`CREATE TABLE ${qMgd} (${colDefsWithMeta})`);

      if (targetExists) {
        // MVCC: readers veem target antiga enquanto este INSERT roda fora de tx. Linhas ausentes da
        // staging sao SEMPRE preservadas (nunca removidas): so o carimbo cw_deleted_at muda.
        //  - fullSnapshot=true: ausencia = "excluido na origem": carimba na primeira rodada em que ocorre
        //    (idempotente: preserva o carimbo se ja estava excluida).
        //  - keysTable (deteccao de exclusoes): chave na lista => desmarca; fora da lista e sincronizada
        //    antes de keysBefore => marca. Ver carryPlan.
        //  - senao (delta parcial): preserva como esta — ausencia so significa "nao mudou neste lote".
        // Schema drift: a origem pode ter ganho/perdido colunas desde a ultima carga.
        // Colunas novas (ausentes no target) entram como NULL nas linhas antigas;
        // colunas so do target sao descartadas (o merged segue o schema atual da origem).
        const tgtColsRes = await this._pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
          [schema, target],
        );
        const tgtCols = new Set(tgtColsRes.rows.map(r => r.column_name));
        const selectList = cols
          .map(c => (tgtCols.has(c.name) ? `t.${pgQuote(c.name)}` : `NULL`))
          .join(", ");
        const useKeys = !fullSnapshot && !!opts?.keysTable && !!opts?.keysBefore;
        const plan = carryPlan({
          q: pgQuote, qStg, key, qSyncedAt, qDeletedAt, now: "now()", fullSnapshot,
          qKeys: useKeys ? `${qSc}.${pgQuote(opts!.keysTable!)}` : null, beforeParam: "$1::timestamp",
        });
        const params = useKeys ? [opts!.keysBefore!] : [];
        if (plan.markedWhere) {
          const m = await this._pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM ${qTgt} t WHERE ${plan.markedWhere}`, params,
          );
          marked = Number(m.rows[0]?.n ?? 0);
        }
        await this._pool.query(
          `INSERT INTO ${qMgd} (${colListWithMeta})
           SELECT ${selectList}, ${plan.syncedAtExpr}, ${plan.deletedAtExpr} FROM ${qTgt} t
           WHERE ${absentFromStaging(qStg, key)}`, params,
        );
      }

      // Copia todos os rows de staging (novos / atualizados) — sempre "vivas": carimba
      // cw_synced_at=agora e cw_deleted_at=NULL (undelete automático).
      await this._pool.query(
        `INSERT INTO ${qMgd} (${colListWithMeta}) SELECT ${colList}, now(), NULL FROM ${qStg}`,
      );

      // Transação breve: DROP target + RENAME merged → target (AccessExclusiveLock ~ms)
      const client = await this._pool.connect();
      try {
        await client.query("BEGIN");
        try {
          if (targetExists) await client.query(`DROP TABLE ${qTgt}`);
          await client.query(`ALTER TABLE ${qMgd} RENAME TO ${pgQuote(target)}`);
          await hideDeletedRows(client, qTgt);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      } finally {
        client.release();
      }
      return { marked };
    } finally {
      // best-effort cleanup
      await this._pool.query(`DROP TABLE IF EXISTS ${qStg}`).catch(() => {});
      await this._pool.query(`DROP TABLE IF EXISTS ${qMgd}`).catch(() => {});
    }
  }

  async serverNow(): Promise<Date> {
    const r = await this._pool.query<{ v: Date }>(`SELECT now()::timestamp AS v`);
    return r.rows[0]!.v;
  }

  async countMissingKeys(
    schema: string, table: string, keyColumn: string, keysTable: string, before: Date,
  ): Promise<{ live: number; candidates: number }> {
    const qTgt = `${pgQuote(schema)}.${pgQuote(table)}`;
    const qKeys = `${pgQuote(schema)}.${pgQuote(keysTable)}`;
    const where = missingKeysWhere({ q: pgQuote, qKeys, key: pgQuote(keyColumn), beforeParam: "$1::timestamp" });
    const r = await this._pool.query<{ live: string; candidates: string }>(
      `SELECT COUNT(*)::text AS live, COUNT(*) FILTER (WHERE ${where})::text AS candidates FROM ${qTgt} t WHERE t.${pgQuote(CW_DELETED_AT)} IS NULL`,
      [before],
    );
    return { live: Number(r.rows[0]?.live ?? 0), candidates: Number(r.rows[0]?.candidates ?? 0) };
  }

  /**
   * Bulk insert com cliente dedicado (dentro de transação).
   * rows[i][j] corresponde a cols[j].
   */
  async bulkInsertClient(
    client: PoolClient,
    schema: string,
    table: string,
    cols: ColDef[],
    rows: unknown[][],
  ): Promise<void> {
    if (!rows.length) return;
    const qTable = `${pgQuote(schema)}.${pgQuote(table)}`;
    const colList = cols.map(c => pgQuote(c.name)).join(", ");
    const params: (string | null)[][] = cols.map(() => []);

    for (const row of rows) {
      for (let j = 0; j < cols.length; j++) {
        const v = row[j];
        params[j]!.push(v == null ? null : String(v));
      }
    }

    const unnestExprs = cols.map((c, i) =>
      `unnest($${i + 1}::text[])::${canonicalToPg(c.sqlType)}`,
    ).join(", ");

    await client.query(
      `INSERT INTO ${qTable} (${colList}) SELECT ${unnestExprs}`,
      params,
    );
  }
}
