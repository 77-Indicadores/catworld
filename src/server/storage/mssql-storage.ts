/**
 * MssqlStorageConnection — adapter SQL Server para dataset storage.
 * Thin wrapper em volta do pool existente de pool.ts.
 */

import { DECIMAL_LEGACY, parseDecimalType, physicalDecimal } from "@/lib/decimal-type";
import sql from "mssql";
import { CW_SYNCED_AT, CW_DELETED_AT, type ColDef, type ColInfo, type StorageConnection } from "./connection";
import { absentFromStaging, carryPlan, missingKeysWhere } from "./delete-detection";

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

const RH = "_cw_rh"; // coluna interna de hash da linha (MD5 hex), quando a tabela a tem

// ─── Type mapping ─────────────────────────────────────────────────────────────

export function canonicalToMssql(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return physicalDecimal(sqlType, "mssql");
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

/** Colunas carregadas como texto exato: BIGINT, DECIMAL com mais de 15 digitos (limite de exatidao de Number) e datas/horas. */
const TEXT_LOADED_RE: Record<string, RegExp> = {
  BIGINT: /^-?\d{1,19}$/,
  DECIMAL: /^-?\d+(?:\.\d+)?$/,
  DATE: /^\d{4}-\d{2}-\d{2}$/,
  DATETIME2: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/,
  TIME: /^\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/,
};
function textLoaded(sqlType: string): boolean {
  if (sqlType === "BIGINT" || sqlType === "DATE" || sqlType === "DATETIME2" || sqlType === "TIME") return true;
  const d = parseDecimalType(sqlType);
  return !!d && d.precision > 15;
}

// ─── Quoting ──────────────────────────────────────────────────────────────────

function mssqlQuote(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

const setRequestTimeout = (req: sql.Request, ms: number) => {
  (req as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = ms;
};

const esc = (s: string) => s.replaceAll("'", "''");

/** Indice em cw_synced_at (base de `rows?since=`). Nome constante e valido: o indice pertence a tabela e acompanha o sp_rename dela. */
const syncedAtIndexSql = (schema: string, table: string) =>
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'${esc(schema)}.${esc(table)}') AND name=N'IX_cw_synced_at')
     CREATE NONCLUSTERED INDEX [IX_cw_synced_at] ON ${mssqlQuote(schema)}.${mssqlQuote(table)} (${mssqlQuote(CW_SYNCED_AT)})`;

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
    // Conta so linhas vivas (marcadas como excluidas na origem nao contam); sem a coluna, todas.
    const has = await p.request().query(
      `SELECT 1 AS x FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = N'${esc(schema)}' AND TABLE_NAME = N'${esc(table)}' AND COLUMN_NAME = N'${esc(CW_DELETED_AT)}'`,
    );
    const where = has.recordset.length > 0 ? ` WHERE ${mssqlQuote(CW_DELETED_AT)} IS NULL` : "";
    const result = await p.request().query(
      `SELECT COUNT_BIG(*) AS n FROM ${mssqlQuote(schema)}.${mssqlQuote(table)}${where}`,
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

    // Tudo que precisa de exatidao entra como TEXTO e o proprio SQL Server converte para o tipo da coluna (o driver tedious passaria por
    // Number/Date: DECIMAL > 15 digitos e BIGINT > 2^53 perderiam precisao, e "YYYY-MM-DD HH:MM:SS.ffffff" seria lido no fuso local e
    // truncado a milissegundos). Valor que nao cabe no tipo faz o bulk FALHAR (nunca arredonda). Ver B1/M6.
    const asText = cols.map((c) => textLoaded(c.sqlType));
    cols.forEach((c, j) => {
      const t = c.sqlType;
      let sqlType: sql.ISqlType | (() => sql.ISqlType);
      if (asText[j]) sqlType = sql.NVarChar(64);
      else if (t.startsWith("DECIMAL")) { const s = parseDecimalType(t) ?? DECIMAL_LEGACY; sqlType = sql.Decimal(s.precision, s.scale); }
      else sqlType = sql.NVarChar(sql.MAX);
      bulk.columns.add(c.name, sqlType, { nullable: c.nullable !== false });
    });

    for (const row of rows) {
      bulk.rows.add(...cols.map((c, j) => {
        const v = row[j];
        if (v == null) return null;
        const s = v instanceof Date ? v.toISOString().replace("T", " ").replace("Z", "") : String(v);
        if (asText[j]) {
          if (s === "") return null;
          if (!TEXT_LOADED_RE[c.sqlType === "BIGINT" ? "BIGINT" : c.sqlType.startsWith("DECIMAL") ? "DECIMAL" : c.sqlType].test(s)) {
            throw new Error(`Valor invalido para ${c.name} (${c.sqlType}): ${s.slice(0, 40)}`);
          }
          return s;
        }
        if (c.sqlType.startsWith("DECIMAL")) return s ? Number(s) : null;
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
    opts?: { targetExists?: boolean; keyColumn?: string | null; mergedName?: string; fullSnapshot?: boolean; keysTable?: string; keysBefore?: Date },
  ): Promise<{ marked: number }> {
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
      { const ix = p.request(); setReqTimeout(ix, 7_200_000); await ix.query(syncedAtIndexSql(schema, staging)); }
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
      return { marked: 0 };
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

    let marked = 0;
    let preserveStamp = false;

    try {
      await p.request().query(`CREATE TABLE ${qMgd} (${colDefsWithMeta})`);

      if (targetExists) {
        // Copia rows de target cujo key NÃO aparece em staging (fora de tx). Linhas ausentes sao SEMPRE
        // preservadas (soft delete): so o carimbo cw_deleted_at muda.
        //  - fullSnapshot=true: ausência = "excluído na origem": carimba na primeira rodada (idempotente).
        //  - keysTable (deteccao de exclusoes): chave na lista => desmarca; fora da lista e sincronizada
        //    antes de keysBefore => marca. Ver carryPlan.
        //  - senao (delta parcial): preserva como está — ausência só significa "não mudou neste lote".
        // Schema drift: colunas novas da origem (ausentes no target) entram como NULL;
        // colunas so do target sao descartadas.
        // Tabela criada pelo caminho de replace "cru" do importer (ou anterior ao soft delete) NÃO tem cw_synced_at/cw_deleted_at: o merge
        // referenciava t.cw_deleted_at e falhava com "Invalid column name" (visto contra SQL Server real). Acrescenta as colunas que faltam.
        const metaRes = await p.request().query(
          `SELECT COL_LENGTH(N'${esc(schema)}.${esc(target)}', N'${esc(CW_SYNCED_AT)}') AS s, COL_LENGTH(N'${esc(schema)}.${esc(target)}', N'${esc(CW_DELETED_AT)}') AS d`,
        );
        const metaRow = metaRes.recordset[0] as { s: number | null; d: number | null };
        if (metaRow.s === null) {
          const addSynced = p.request(); setReqTimeout(addSynced, 7_200_000);
          await addSynced.query(`ALTER TABLE ${qTgt} ADD ${qSyncedAt} DATETIME2 NOT NULL CONSTRAINT ${mssqlQuote(`DF_${target}_${CW_SYNCED_AT}`.slice(0, 120))} DEFAULT SYSUTCDATETIME()`);
        }
        if (metaRow.d === null) {
          await p.request().query(`ALTER TABLE ${qTgt} ADD ${qDeletedAt} DATETIME2 NULL`);
        }
        const tgtColsRes = await p.request().query(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = N'${esc(schema)}' AND TABLE_NAME = N'${esc(target)}'`,
        );
        const tgtCols = new Set((tgtColsRes.recordset as { COLUMN_NAME: string }[]).map(r => r.COLUMN_NAME));
        preserveStamp = tgtCols.has(RH) && tgtCols.has(CW_SYNCED_AT) && tgtCols.has(CW_DELETED_AT) && cols.some(c => c.name === RH);
        const selectList = cols
          .map(c => (tgtCols.has(c.name) ? `t.${mssqlQuote(c.name)}` : `NULL`))
          .join(", ");
        const useKeys = !fullSnapshot && !!opts?.keysTable && !!opts?.keysBefore;
        const plan = carryPlan({
          q: mssqlQuote, qStg, key, qSyncedAt, qDeletedAt, now: "SYSUTCDATETIME()", fullSnapshot,
          qKeys: useKeys ? `${qSc}.${mssqlQuote(opts!.keysTable!)}` : null, beforeParam: "@before",
        });
        const withBefore = (req: sql.Request) => (useKeys ? req.input("before", sql.DateTime2, opts!.keysBefore!) : req);
        if (plan.markedWhere) {
          const mReq = withBefore(p.request());
          setReqTimeout(mReq, 7_200_000);
          const m = await mReq.query(`SELECT COUNT_BIG(*) AS n FROM ${qTgt} t WHERE ${plan.markedWhere} OPTION (MAXDOP 1)`);
          marked = Number(String(m.recordset[0]?.n ?? "0"));
        }
        const copyReq = withBefore(p.request());
        setReqTimeout(copyReq, 7_200_000);
        await copyReq.query(
          `INSERT INTO ${qMgd} (${colListWithMeta})
           SELECT ${selectList}, ${plan.syncedAtExpr}, ${plan.deletedAtExpr} FROM ${qTgt} t
           WHERE ${absentFromStaging(qStg, key)}
           OPTION (MAXDOP 1)`,
        );
      }

      // Copia todos os rows de staging (novos / atualizados) — sempre "vivas": carimba
      // cw_synced_at=agora e cw_deleted_at=NULL (undelete automático se a chave tinha
      // sido excluída antes e voltou a aparecer na origem).
      // Com a coluna de hash `_cw_rh` nos dois lados, a linha cujo CONTEUDO nao mudou (mesmo hash, viva) mantem o cw_synced_at
      // anterior (H4): reler linhas iguais nao as reapresenta em `rows?since=`. Sem `_cw_rh`, toda linha lida e carimbada agora.
      const insReq = p.request();
      setReqTimeout(insReq, 7_200_000);
      if (preserveStamp) {
        const sCols = cols.map(c => `s.${mssqlQuote(c.name)}`).join(", ");
        const rh = mssqlQuote(RH);
        await insReq.query(
          `INSERT INTO ${qMgd} (${colListWithMeta})
           SELECT ${sCols}, COALESCE(p.sa, SYSUTCDATETIME()), NULL FROM ${qStg} s
           LEFT JOIN (SELECT ${key} AS k, ${rh} AS rh, MAX(${qSyncedAt}) AS sa FROM ${qTgt} WHERE ${qDeletedAt} IS NULL GROUP BY ${key}, ${rh}) p
             ON p.k = s.${key} AND p.rh = s.${rh} OPTION (MAXDOP 1)`,
        );
      } else await insReq.query(
        `INSERT INTO ${qMgd} (${colListWithMeta}) SELECT ${colList}, SYSUTCDATETIME(), NULL FROM ${qStg} OPTION (MAXDOP 1)`,
      );

      { const ix = p.request(); setReqTimeout(ix, 7_200_000); await ix.query(syncedAtIndexSql(schema, mergedName)); }

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
        if (targetExists) await req.query(`DROP TABLE ${qTgt}`);
        await req.query(`EXEC sp_rename N'${esc(schema)}.${esc(mergedName)}', N'${esc(target)}'`);
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      }
      return { marked };
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

  async countMissingKeys(
    schema: string, table: string, keyColumn: string, keysTable: string, before: Date,
  ): Promise<{ live: number; candidates: number }> {
    const p = await this.rawPool();
    const qTgt = `${mssqlQuote(schema)}.${mssqlQuote(table)}`;
    const qKeys = `${mssqlQuote(schema)}.${mssqlQuote(keysTable)}`;
    const where = missingKeysWhere({ q: mssqlQuote, qKeys, key: mssqlQuote(keyColumn), beforeParam: "@before" });
    const req = p.request().input("before", sql.DateTime2, before);
    setRequestTimeout(req, 7_200_000);
    const r = await req.query(
      `SELECT COUNT_BIG(*) AS live, SUM(CASE WHEN ${where} THEN 1 ELSE 0 END) AS candidates FROM ${qTgt} t WHERE t.${mssqlQuote(CW_DELETED_AT)} IS NULL OPTION (MAXDOP 1)`,
    );
    const row = (r.recordset as { live: number | string | null; candidates: number | null }[])[0];
    return { live: Number(row?.live ?? 0), candidates: Number(row?.candidates ?? 0) };
  }
}
