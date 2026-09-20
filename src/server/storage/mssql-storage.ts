/**
 * MssqlStorageConnection — adapter SQL Server para dataset storage.
 * Thin wrapper em volta do pool existente de pool.ts.
 */

import sql from "mssql";
import { CW_SYNCED_AT, CW_DELETED_AT, type ColDef, type ColInfo, type StorageConnection } from "./connection";
import { deleteMissingKeysSql, keysCheckExceeds, mergeRemovalPlan, missingKeysWhere, tombstoneTableName, KEYS_CHECK_MAX_RATIO, TOMB_AT, TOMB_KEY, type MarkMissingKeysOpts, type MarkMissingKeysResult } from "./delete-detection";

// ─── URL parsing ──────────────────────────────────────────────────────────────

function parseMssqlUrl(url: string): sql.config {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = (hostPort ?? "").split(":");
  const params = Object.fromEntries(
    rest.map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i).toLowerCase(), part.slice(i + 1)];
    }),
  );
  return {
    server: server ?? "",
    port: port ? Number(port) : 1433,
    database: params.database,
    user: params.user,
    password: params.password,
    options: {
      encrypt: params.encrypt !== "false",
      trustServerCertificate: params.trustservercertificate === "true",
      packetSize: 16384,
    },
    requestTimeout: 600_000,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 },
  };
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

export function canonicalToMssql(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return "DECIMAL(18,4)";
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "DATETIME2";
  if (sqlType === "TIME") return "TIME";
  // CHAR(32) só é usado pela coluna interna _cw_rh (hash MD5 hex, sempre 32
  // chars) — precisa ficar indexável (NVARCHAR(MAX) nunca pode ser coluna de
  // índice no SQL Server). Ver nota em importer.ts sobre mappingWithRh.
  if (sqlType === "CHAR(32)") return "CHAR(32)";
  return "NVARCHAR(MAX)";
}

function mssqlToCanonical(r: {
  type_name: string;
  prec: number;
  scale: number;
}): string {
  const t = r.type_name.toLowerCase();
  if (t === "bigint") return "BIGINT";
  if (t === "decimal" || t === "numeric") return `DECIMAL(${r.prec},${r.scale})`;
  if (t === "date") return "DATE";
  if (t === "datetime2") return "DATETIME2";
  if (t === "time") return "TIME";
  return "NVARCHAR(MAX)";
}

// ─── Quoting ──────────────────────────────────────────────────────────────────

function mssqlQuote(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

const setRequestTimeout = (req: sql.Request, ms: number) => {
  (req as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = ms;
};

const esc = (s: string) => s.replaceAll("'", "''");

// ─── Pool cache ───────────────────────────────────────────────────────────────

const poolCache = new Map<string, Promise<sql.ConnectionPool>>();

function getPool(id: string, url: string): Promise<sql.ConnectionPool> {
  if (!poolCache.has(id)) {
    const pool = new sql.ConnectionPool(parseMssqlUrl(url));
    pool.on("error", () => { poolCache.delete(id); });
    const promise = pool.connect().catch((err) => { poolCache.delete(id); throw err; });
    poolCache.set(id, promise);
  }
  return poolCache.get(id)!;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class MssqlStorageConnection implements StorageConnection {
  readonly provider = "sqlserver" as const;
  private readonly _id: string;
  private readonly _url: string;

  constructor(id: string, url: string) {
    this._id = id;
    this._url = url;
  }

  /** Expõe o pool raw para o importer.ts (mantém compatibilidade) */
  async rawPool(): Promise<sql.ConnectionPool> {
    return getPool(this._id, this._url);
  }

  q(identifier: string): string {
    return mssqlQuote(identifier);
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  async createSchemaIfNotExists(schema: string): Promise<void> {
    const p = await this.rawPool();
    const q = mssqlQuote(schema);
    await p.request().query(`IF SCHEMA_ID(N'${esc(schema)}') IS NULL EXEC(N'CREATE SCHEMA ${q}')`);
  }

  async dropSchemaIfExists(schema: string): Promise<void> {
    const p = await this.rawPool();
    const q = mssqlQuote(schema);
    const tables = await p.request().query<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${esc(schema)}'`,
    );
    for (const row of tables.recordset) {
      await p.request().query(
        `IF OBJECT_ID(N'${esc(schema)}.${esc(row.name)}',N'U') IS NOT NULL DROP TABLE ${q}.${mssqlQuote(row.name)}`,
      );
    }
    await p.request().query(`IF SCHEMA_ID(N'${esc(schema)}') IS NOT NULL DROP SCHEMA ${q}`);
  }

  // ── Tables ──────────────────────────────────────────────────────────────────

  async tableExists(schema: string, table: string): Promise<boolean> {
    const p = await this.rawPool();
    const result = await p.request().query(
      `SELECT CASE WHEN OBJECT_ID(N'${esc(schema)}.${esc(table)}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`,
    );
    return Number(result.recordset[0]?.ok) === 1;
  }

  async createTable(schema: string, table: string, cols: ColDef[]): Promise<void> {
    const p = await this.rawPool();
    const colDefs = cols
      .map(c => `${mssqlQuote(c.name)} ${canonicalToMssql(c.sqlType)}${c.nullable ? " NULL" : " NOT NULL"}`)
      .join(", ");
    await p.request().query(
      `CREATE TABLE ${mssqlQuote(schema)}.${mssqlQuote(table)} (${colDefs})`,
    );
  }

  async dropTableIfExists(schema: string, table: string): Promise<void> {
    const p = await this.rawPool();
    await p.request().query(
      `IF OBJECT_ID(N'${esc(schema)}.${esc(table)}',N'U') IS NOT NULL DROP TABLE ${mssqlQuote(schema)}.${mssqlQuote(table)}`,
    );
  }

  async renameTable(schema: string, oldName: string, newName: string): Promise<void> {
    const p = await this.rawPool();
    await p.request().query(`EXEC sp_rename N'${esc(schema)}.${esc(oldName)}', N'${esc(newName)}'`);
  }

  async listTables(schema: string): Promise<string[]> {
    const p = await this.rawPool();
    const result = await p.request().query<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${esc(schema)}' ORDER BY t.name`,
    );
    return result.recordset.map(r => r.name);
  }

  async listColumns(schema: string, table: string): Promise<ColInfo[]> {
    const p = await this.rawPool();
    const result = await p.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query<{ name: string; type_name: string; prec: number; scale: number; nullable: boolean }>(
        `SELECT c.name, ty.name type_name, c.precision prec, c.scale scale, c.is_nullable nullable
         FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id
         WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))
         ORDER BY c.column_id`,
      );
    return result.recordset.map(r => ({
      name: r.name,
      sqlType: mssqlToCanonical(r),
      nullable: r.nullable,
    }));
  }

  async countRows(schema: string, table: string): Promise<bigint> {
    const p = await this.rawPool();
    const result = await p.request().query(
      `SELECT COUNT_BIG(*) AS n FROM ${mssqlQuote(schema)}.${mssqlQuote(table)}`,
    );
    return BigInt(String(result.recordset[0]?.n ?? "0"));
  }

  // ── Raw SQL ─────────────────────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(sqlStr: string): Promise<T[]> {
    const p = await this.rawPool();
    const result = await p.request().query(sqlStr);
    return result.recordset as T[];
  }

  async execute(sqlStr: string): Promise<number> {
    const p = await this.rawPool();
    const result = await p.request().query(sqlStr);
    return result.rowsAffected?.[0] ?? 0;
  }

  // ── Bulk insert ──────────────────────────────────────────────────────────────

  async bulkInsert(schema: string, table: string, cols: ColDef[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const p = await this.rawPool();
    const bulk = new sql.Table(`${schema}.${table}`);
    bulk.create = false;

    for (const c of cols) {
      const t = c.sqlType;
      let sqlType: sql.ISqlType | (() => sql.ISqlType);
      if (t === "BIGINT") sqlType = sql.BigInt;
      else if (t.startsWith("DECIMAL")) sqlType = sql.Decimal(18, 4);
      else if (t === "DATE") sqlType = sql.Date;
      else if (t === "DATETIME2") sqlType = sql.DateTime2(7);
      else if (t === "TIME") sqlType = sql.Time(7);
      else sqlType = sql.NVarChar(sql.MAX);
      bulk.columns.add(c.name, sqlType, { nullable: true });
    }

    for (const row of rows) {
      bulk.rows.add(...cols.map((c, j) => {
        const v = row[j];
        if (v == null) return null;
        const s = String(v);
        if (c.sqlType === "BIGINT") return s ? parseInt(s, 10) : null;
        if (c.sqlType.startsWith("DECIMAL")) return s ? parseFloat(s) : null;
        return s;
      }) as Parameters<typeof bulk.rows.add>);
    }

    const req = new sql.Request(p);
    // tableLock: row-level locks → single table lock para bulk (staging apenas)
    await req.bulk(bulk, { tableLock: true });
  }

  // ── Transactions ─────────────────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const p = await this.rawPool();
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      const result = await fn();
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  // ── Atomic swap ───────────────────────────────────────────────────────────────

  async atomicSwap(
    schema: string,
    staging: string,
    target: string,
    cols: ColDef[],
    opts?: { targetExists?: boolean; keyColumn?: string | null; mergedName?: string; fullSnapshot?: boolean; scopeColumns?: string[] },
  ): Promise<{ removed: number }> {
    const p = await this.rawPool();
    const qSc = mssqlQuote(schema);
    const qStg = `${qSc}.${mssqlQuote(staging)}`;
    const qTgt = `${qSc}.${mssqlQuote(target)}`;
    const targetExists = opts?.targetExists ?? true;
    const keyColumn = opts?.keyColumn ?? null;
    const fullSnapshot = opts?.fullSnapshot ?? false;
    const qSyncedAt = mssqlQuote(CW_SYNCED_AT);
    const qDeletedAt = mssqlQuote(CW_DELETED_AT);

    const setReqTimeout = setRequestTimeout;

    if (!keyColumn) {
      // Carimba cw_synced_at/cw_deleted_at na staging ANTES do swap — DEFAULT stampa
      // todas as linhas existentes com o mesmo timestamp (calculado uma vez), coerente
      // com "todo o lote foi visto agora". Fora da transação breve de rename (não é
      // hot path de lock).
      // Guarda condicional: staging pode já ter essas colunas numa tentativa anterior —
      // o importer reaproveita a staging (não recria do zero) quando um job de upload é
      // reprocessado após falha parcial (ver comentário de idempotência em importer.ts).
      // MSSQL não tem "ADD COLUMN IF NOT EXISTS" — checa via COL_LENGTH.
      // NÃO nomear a constraint DEFAULT: o nome da staging é fixo por fonte e a
      // constraint sobrevive ao rename staging→target, então um nome fixo colidia na
      // carga seguinte ("Could not create constraint or index"). Sem nome, o SQL
      // Server gera um único.
      await p.request().query(
        `IF COL_LENGTH('${esc(schema)}.${esc(staging)}', '${esc(CW_SYNCED_AT)}') IS NULL
         ALTER TABLE ${qStg} ADD ${qSyncedAt} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), ${qDeletedAt} DATETIME2 NULL`,
      );
      // ── fullSwap: DROP target + RENAME staging → target (transação breve) ──────
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        const req = new sql.Request(tx);
        // DROP TABLE precisa de lock exclusivo de schema — qualquer leitura
        // concorrente na tabela (dashboard, /api/v1/queries, OData) bloqueia até
        // terminar. 30s já se mostrou curto demais em produção quando um
        // relatório mais pesado está lendo a tabela no momento do swap
        // ("Timeout: Request failed to complete in 30000ms"); o job em si já
        // tem retry (até 5 tentativas), então um timeout mais generoso aqui
        // reduz falsos positivos sem esconder um lock realmente preso.
        setReqTimeout(req, 120_000);
        if (targetExists) await req.query(`DROP TABLE ${qTgt}`);
        await req.query(`EXEC sp_rename N'${esc(schema)}.${esc(staging)}', N'${esc(target)}'`);
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        // best-effort: drop staging se rename não ocorreu
        await p.request().query(
          `IF OBJECT_ID(N'${esc(schema)}.${esc(staging)}','U') IS NOT NULL DROP TABLE ${qStg}`,
        ).catch(() => {});
        throw e;
      }
      return { removed: 0 };
    }

    // ── mergeSwap: materializa resultado final em temp, depois DDL breve ─────────
    // Leituras na target não bloqueiam enquanto os INSERTs no merged correm fora de tx.
    const mergedName = opts?.mergedName ?? `cw_mgd_${staging.slice(0, 16)}`;
    const qMgd = `${qSc}.${mssqlQuote(mergedName)}`;
    const key = mssqlQuote(keyColumn);
    const colDefs = cols
      .map(c => `${mssqlQuote(c.name)} ${canonicalToMssql(c.sqlType)}${c.nullable ? " NULL" : " NOT NULL"}`)
      .join(", ");
    const colList = cols.map(c => mssqlQuote(c.name)).join(", ");
    const colDefsWithMeta = `${colDefs}, ${qSyncedAt} DATETIME2 NOT NULL, ${qDeletedAt} DATETIME2 NULL`;
    const colListWithMeta = `${colList}, ${qSyncedAt}, ${qDeletedAt}`;

    // Remove eventual sobra de tentativa anterior
    await p.request().query(
      `IF OBJECT_ID(N'${esc(schema)}.${esc(mergedName)}','U') IS NOT NULL DROP TABLE ${qMgd}`,
    );

    const tombName = tombstoneTableName(target);
    const qTomb = `${qSc}.${mssqlQuote(tombName)}`;
    let plan: ReturnType<typeof mergeRemovalPlan> | null = null;
    let removed = 0;

    try {
      await p.request().query(`CREATE TABLE ${qMgd} (${colDefsWithMeta})`);

      if (targetExists) {
        // Copia rows de target cujo key NÃO aparece em staging (fora de tx). Se ha remocao
        // (fullSnapshot ou escopo), a ausência na staging significa "excluído na origem": a
        // linha NAO e copiada (remocao fisica) e vira lapide na transacao do swap. Sem
        // remocao (delta parcial), ausência só significa "não mudou neste lote": copia como esta.
        // Schema drift: colunas novas da origem (ausentes no target) entram como NULL;
        // colunas so do target sao descartadas.
        const tgtColsRes = await p.request().query(
          `SELECT c.name AS column_name FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'${esc(schema)}.${esc(target)}',N'U')`,
        );
        const tgtCols = new Set((tgtColsRes.recordset as { column_name: string }[]).map(r => r.column_name));
        const selectList = cols
          .map(c => (tgtCols.has(c.name) ? `t.${mssqlQuote(c.name)}` : `NULL`))
          .join(", ");
        // Escopo: linha ausente da staging cuja tupla de escopo existe na staging = excluida na
        // origem. Coluna de escopo ausente no target (schema drift): nao avalia, preserva.
        const scopeCols = opts?.scopeColumns?.length && opts.scopeColumns.every(c => tgtCols.has(c)) ? opts.scopeColumns : null;
        plan = mergeRemovalPlan({
          dialect: "mssql", q: mssqlQuote, qTgt, qStg, qTomb, key, qDeletedAt, now: "SYSUTCDATETIME()", fullSnapshot, scopeColumns: scopeCols,
        });
        const copyReq = p.request();
        setReqTimeout(copyReq, 7_200_000);
        await copyReq.query(
          `INSERT INTO ${qMgd} (${colListWithMeta})
           SELECT ${selectList}, t.${qSyncedAt}, t.${qDeletedAt} FROM ${qTgt} t
           ${plan.copyJoin}
           WHERE ${plan.copyWhere}
           OPTION (MAXDOP 1)`,
        );
        if (plan.active) {
          const keyCol = cols.find(c => c.name === keyColumn);
          await this.ensureTombstoneTable(schema, target, keyCol?.sqlType ?? "NVARCHAR(MAX)");
        }
      }

      // Copia todos os rows de staging (novos / atualizados) — sempre "vivas": carimba
      // cw_synced_at=agora e cw_deleted_at=NULL (undelete automático se a chave tinha
      // sido excluída antes e voltou a aparecer na origem).
      const insReq = p.request();
      setReqTimeout(insReq, 7_200_000);
      await insReq.query(
        `INSERT INTO ${qMgd} (${colListWithMeta}) SELECT ${colList}, SYSUTCDATETIME(), NULL FROM ${qStg} OPTION (MAXDOP 1)`,
      );

      // Transação breve: DROP target + RENAME merged → target (~ms de lock)
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        const req = new sql.Request(tx);
        // DROP TABLE precisa de lock exclusivo de schema — qualquer leitura
        // concorrente na tabela (dashboard, /api/v1/queries, OData) bloqueia até
        // terminar. 30s já se mostrou curto demais em produção quando um
        // relatório mais pesado está lendo a tabela no momento do swap
        // ("Timeout: Request failed to complete in 30000ms"); o job em si já
        // tem retry (até 5 tentativas), então um timeout mais generoso aqui
        // reduz falsos positivos sem esconder um lock realmente preso.
        setReqTimeout(req, 120_000);
        if (plan) {
          // Lapides na MESMA transacao da remocao: revive chaves que voltaram; registra as removidas.
          if (plan.active || await this.tableExists(schema, tombName)) await req.query(plan.revive);
          if (plan.active) removed = (await req.query(plan.insert)).rowsAffected[0] ?? 0;
        }
        if (targetExists) await req.query(`DROP TABLE ${qTgt}`);
        await req.query(`EXEC sp_rename N'${esc(schema)}.${esc(mergedName)}', N'${esc(target)}'`);
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      }
      return { removed };
    } finally {
      // best-effort: remove staging (ainda existe se não foi renomeada) e merged (idem)
      await p.request().query(
        `IF OBJECT_ID(N'${esc(schema)}.${esc(staging)}','U') IS NOT NULL DROP TABLE ${qStg}`,
      ).catch(() => {});
      await p.request().query(
        `IF OBJECT_ID(N'${esc(schema)}.${esc(mergedName)}','U') IS NOT NULL DROP TABLE ${qMgd}`,
      ).catch(() => {});
    }
  }

  async serverNow(): Promise<Date> {
    const p = await this.rawPool();
    const r = await p.request().query(`SELECT SYSUTCDATETIME() AS v`);
    return (r.recordset as { v: Date }[])[0]!.v;
  }

  async ensureTombstoneTable(schema: string, table: string, keySqlType: string): Promise<void> {
    const p = await this.rawPool();
    const name = tombstoneTableName(table);
    await p.request().query(
      `IF OBJECT_ID(N'${esc(schema)}.${esc(name)}','U') IS NULL
       CREATE TABLE ${mssqlQuote(schema)}.${mssqlQuote(name)} (${mssqlQuote(TOMB_KEY)} ${canonicalToMssql(keySqlType)} NULL, ${mssqlQuote(TOMB_AT)} DATETIME2 NOT NULL)`,
    );
  }

  async markMissingKeysDeleted(
    schema: string, table: string, keyColumn: string, keysTable: string, before: Date, opts?: MarkMissingKeysOpts,
  ): Promise<MarkMissingKeysResult> {
    const p = await this.rawPool();
    const qTgt = `${mssqlQuote(schema)}.${mssqlQuote(table)}`;
    const qKeys = `${mssqlQuote(schema)}.${mssqlQuote(keysTable)}`;
    const qTomb = `${mssqlQuote(schema)}.${mssqlQuote(tombstoneTableName(table))}`;
    const where = missingKeysWhere({ q: mssqlQuote, qKeys, key: mssqlQuote(keyColumn), beforeParam: "@before" });
    const countReq = p.request().input("before", sql.DateTime2, before);
    setRequestTimeout(countReq, 7_200_000);
    const c = await countReq.query(
      `SELECT COUNT_BIG(*) AS live, SUM(CASE WHEN ${where} THEN 1 ELSE 0 END) AS candidates FROM ${qTgt} t OPTION (MAXDOP 1)`,
    );
    const row = (c.recordset as { live: number | string | null; candidates: number | null }[])[0];
    const live = Number(row?.live ?? 0);
    const candidates = Number(row?.candidates ?? 0);
    if (keysCheckExceeds({ candidates, live }, opts?.maxRatio ?? KEYS_CHECK_MAX_RATIO)) return { marked: 0, candidates, live, aborted: true };
    if (candidates === 0) return { marked: 0, candidates, live, aborted: false };
    const keyCol = (await this.listColumns(schema, keysTable)).find(k => k.name === keyColumn);
    await this.ensureTombstoneTable(schema, table, keyCol?.sqlType ?? "NVARCHAR(MAX)");
    const delReq = p.request().input("before", sql.DateTime2, before);
    setRequestTimeout(delReq, 7_200_000);
    const res = await delReq.query(
      deleteMissingKeysSql({ dialect: "mssql", q: mssqlQuote, qTgt, qTomb, key: mssqlQuote(keyColumn), where }),
    );
    return { marked: res.rowsAffected[0] ?? 0, candidates, live, aborted: false };
  }

  async convertLegacyDeleted(schema: string, table: string, keyColumn: string): Promise<number> {
    if (!(await this.tableExists(schema, table))) return 0;
    const cols = await this.listColumns(schema, table);
    const keyCol = cols.find(c => c.name === keyColumn);
    if (!keyCol || !cols.some(c => c.name === CW_DELETED_AT)) return 0;
    const p = await this.rawPool();
    const qTgt = `${mssqlQuote(schema)}.${mssqlQuote(table)}`;
    const qTomb = `${mssqlQuote(schema)}.${mssqlQuote(tombstoneTableName(table))}`;
    const qDel = mssqlQuote(CW_DELETED_AT);
    const n = await p.request().query(`SELECT COUNT_BIG(*) AS n FROM ${qTgt} WHERE ${qDel} IS NOT NULL`);
    if (Number(n.recordset[0]?.n ?? 0) === 0) return 0;
    await this.ensureTombstoneTable(schema, table, keyCol.sqlType);
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      setRequestTimeout(req, 7_200_000);
      const key = mssqlQuote(keyColumn);
      await req.query(
        `INSERT INTO ${qTomb} (${mssqlQuote(TOMB_KEY)}, ${mssqlQuote(TOMB_AT)}) SELECT t.${key}, t.${qDel} FROM ${qTgt} t WHERE t.${qDel} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qTomb} k WHERE k.${mssqlQuote(TOMB_KEY)} = t.${key})`,
      );
      const del = await req.query(`DELETE FROM ${qTgt} WHERE ${qDel} IS NOT NULL`);
      await tx.commit();
      return del.rowsAffected[0] ?? 0;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  async purgeTombstones(schema: string, table: string, olderThanDays: number): Promise<number> {
    const tomb = tombstoneTableName(table);
    if (olderThanDays <= 0 || !(await this.tableExists(schema, tomb))) return 0;
    const p = await this.rawPool();
    const res = await p.request().input("d", sql.Int, Math.floor(olderThanDays)).query(
      `DELETE FROM ${mssqlQuote(schema)}.${mssqlQuote(tomb)} WHERE ${mssqlQuote(TOMB_AT)} < DATEADD(day, -@d, SYSUTCDATETIME())`,
    );
    return res.rowsAffected[0] ?? 0;
  }
}
