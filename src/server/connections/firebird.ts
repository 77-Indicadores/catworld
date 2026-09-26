/**
 * Adapter de origem Firebird — espelha a forma de `postgres.ts`/`mssql.ts` (mesmo padrão de hoje: funções
 * livres por provider, chamadas via branch em `sources.ts`/`live.ts`, não uma interface polimórfica — ver
 * docs/firebird-ftp-provider.md secao 1).
 *
 * Diferença de propósito: Postgres/MSSQL conectam direto na origem do cliente. Aqui o "endpoint" é sempre o
 * Firebird EFÊMERO que `firebird-materialize.ts` restaurou a partir do backup do FTP — localhost, sysdba,
 * uma senha gerada por materialização (nunca a credencial do cliente). Por isso não há aqui SSH tunnel nem
 * `encryptedCredentials`: quem monta o `FirebirdEndpoint` é o chamador (a partir de `ConnectionMaterialization`).
 */
// Import de namespace (nao default): node-firebird e CJS sem export default de verdade — um import default
// resolve pra undefined sob esbuild/tsx (confirmado rodando scripts/verify-firebird-adapter.ts), mesmo com
// esModuleInterop:true no tsconfig (isso so cobre a emissao do proprio tsc, nao de outros bundlers/runners).
import * as Firebird from "node-firebird";
import type { Database, Options } from "node-firebird";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import type { SourceColumn } from "./postgres";

export type FirebirdEndpoint = {
  host: string;
  port: number;
  /** caminho absoluto do .fdb restaurado no host que roda o servidor Firebird (não uma "databaseName" lógica: é o arquivo). */
  database: string;
  user: string;
  password: string;
  /** charset da conexão (o do banco de origem, ex. WIN1252 em ERPs Firebird brasileiros antigos); default UTF8. */
  charset?: string;
};

function options(endpoint: FirebirdEndpoint): Options {
  return {
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    password: endpoint.password,
    encoding: (endpoint.charset ?? "UTF8") as Options["encoding"],
    // NUMERIC/DECIMAL e BIGINT/INT128 sempre como string exata — mesmo principio de fidelidade decimal do
    // resto do projeto (parseDecimalType/fitDecimal): nunca passar por Number e perder digitos. Confirmado
    // contra dado real do TMK: NUMERIC(12,4) volta "0.0000" exato; DOUBLE PRECISION nativo (comum em ERPs
    // Firebird antigos para campos de valor) NAO e afetado por isto — continua float, por isso mapFirebirdType
    // marca esses como lossyNumeric.
    numericMode: "string",
    // NAO forcar wireCrypt aqui: e a conexao com o NOSSO servidor (o que restaurou o arquivo), nunca com o do
    // cliente, entao usamos a negociacao padrao do driver. Forcar DISABLE (pensado originalmente para talvez
    // precisar falar com um Firebird 2.5/3.0 antigo) quebra contra Firebird 5.x, que e o motor que a imagem usa
    // (confirmado: erro "Incompatible wire encryption levels" testando contra Firebird 5.0.4 real).
  };
}

async function withFirebird<T>(endpoint: FirebirdEndpoint, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = await Firebird.attachAsync(options(endpoint));
  try {
    return await fn(db);
  } finally {
    await db.detachAsync().catch(() => undefined);
  }
}

export async function testFirebird(endpoint: FirebirdEndpoint) {
  const started = Date.now();
  await withFirebird(endpoint, (db) => db.queryAsync("SELECT 1 FROM RDB$DATABASE"));
  return { latencyMs: Date.now() - started };
}

/** Firebird não tem schema (namespace único por banco) — existe só para a UI de fonte ter o mesmo formato das outras. */
export async function listSchemasFirebird(): Promise<{ schema: string }[]> {
  return [{ schema: "public" }];
}

export async function listTablesFirebird(endpoint: FirebirdEndpoint): Promise<{ schema: string; table: string }[]> {
  return withFirebird(endpoint, async (db) => {
    const rows = await db.queryAsync<{ NAME: string }>(
      `SELECT TRIM(RDB$RELATION_NAME) AS NAME FROM RDB$RELATIONS
       WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0) AND RDB$RELATION_NAME NOT STARTING WITH 'RDB$' AND RDB$RELATION_NAME NOT STARTING WITH 'MON$'
       ORDER BY 1`,
    );
    return rows.map((r) => ({ schema: "public", table: r.NAME }));
  });
}

// RDB$FIELD_TYPE (catálogo Firebird — ver Firebird Language Reference, "System Tables"): códigos estáveis desde a 1.0.
const FB_TYPE = { SHORT: 7, LONG: 8, FLOAT: 10, DATE: 12, TIME: 13, CHAR: 14, INT64: 16, DOUBLE: 27, TIMESTAMP: 35, VARCHAR: 37, BLOB: 261, INT128: 26, BOOLEAN: 23 } as const;

type FbFieldRow = {
  FIELD_NAME: string; FIELD_TYPE: number; SUB_TYPE: number | null; FIELD_LENGTH: number | null;
  FIELD_PRECISION: number | null; FIELD_SCALE: number | null; NULL_FLAG: number | null; CHARSET: string | null;
};

/** Mapeia o tipo físico do Firebird para o convencionado no restante do projeto (mesmas famílias usadas por postgres.ts/mssql.ts). */
function mapFirebirdType(row: FbFieldRow): { sqlType: string; lossyNumeric?: boolean } {
  const scale = row.FIELD_SCALE ?? 0; // negativo = casas decimais (convenção do catálogo Firebird)
  const isFixedPoint = scale < 0 && ([FB_TYPE.SHORT, FB_TYPE.LONG, FB_TYPE.INT64, FB_TYPE.INT128] as number[]).includes(row.FIELD_TYPE);
  if (isFixedPoint) {
    const precision = row.FIELD_PRECISION ?? (row.FIELD_TYPE === FB_TYPE.INT64 ? 18 : row.FIELD_TYPE === FB_TYPE.INT128 ? 38 : 9);
    return { sqlType: `DECIMAL(${precision},${-scale})` };
  }
  switch (row.FIELD_TYPE) {
    case FB_TYPE.SHORT: return { sqlType: "INT" };
    case FB_TYPE.LONG: return { sqlType: "INT" };
    case FB_TYPE.INT64: return { sqlType: "BIGINT" };
    case FB_TYPE.INT128: return { sqlType: "DECIMAL(38,0)" };
    case FB_TYPE.FLOAT: case FB_TYPE.DOUBLE: return { sqlType: "FLOAT", lossyNumeric: true };
    case FB_TYPE.DATE: return { sqlType: "DATE" };
    case FB_TYPE.TIME: return { sqlType: "TIME" };
    case FB_TYPE.TIMESTAMP: return { sqlType: "DATETIME2" };
    case FB_TYPE.BOOLEAN: return { sqlType: "BIT" };
    case FB_TYPE.CHAR: case FB_TYPE.VARCHAR: {
      const len = row.FIELD_LENGTH ?? 255;
      return { sqlType: `NVARCHAR(${Math.min(Math.max(len, 1), 4000)})` };
    }
    case FB_TYPE.BLOB:
      // SUB_TYPE 1 = texto (memo); qualquer outro (0 = binário genérico, negativo = definido pelo usuário) vira binário.
      return row.SUB_TYPE === 1 ? { sqlType: "NVARCHAR(MAX)" } : { sqlType: "VARBINARY(MAX)" };
    default:
      return { sqlType: "NVARCHAR(MAX)" };
  }
}

// Códigos do protocolo WIRE (node-firebird, describeField/SQL_TYPE_NAMES em wire/xsqlvar.js e wire/const.js) —
// NÃO são os mesmos códigos de RDB$FIELD_TYPE do catálogo (FB_TYPE acima). queryColumnsFirebird sonda uma
// QUERY (não uma tabela do catálogo), então o driver só entrega esses códigos wire; usar FB_TYPE/mapFirebirdType
// aqui faz todo campo cair no "default" e virar NVARCHAR(MAX) sempre — bug real, achado testando a materialização
// de verdade em produção contra o backup da Jacy Construtora (2026-09-25): as 7 colunas de um SELECT com AS
// vieram todas NVARCHAR(MAX) em vez de bigint/numeric/date.
const WIRE_TYPE = {
  TEXT: 452, VARYING: 448, SHORT: 500, LONG: 496, FLOAT: 482, DOUBLE: 480, D_FLOAT: 530, TIMESTAMP: 510,
  BLOB: 520, TYPE_TIME: 560, TYPE_DATE: 570, INT64: 580, INT128: 32752, TIMESTAMP_TZ: 32754,
  TIMESTAMP_TZ_EX: 32748, TIME_TZ: 32756, TIME_TZ_EX: 32750, DEC16: 32760, DEC34: 32762, BOOLEAN: 32764,
} as const;

type WireField = { type: number; subType: number | null; length: number | null; scale: number | null };

/** Mapeia o tipo físico de uma coluna de QUERY (protocolo wire, não catálogo) — ver nota acima. */
function mapFirebirdWireType(col: WireField): { sqlType: string; lossyNumeric?: boolean } {
  const scale = col.scale ?? 0; // negativo = casas decimais, mesma convenção do catálogo
  const isFixedPoint = scale < 0 && ([WIRE_TYPE.SHORT, WIRE_TYPE.LONG, WIRE_TYPE.INT64, WIRE_TYPE.INT128] as number[]).includes(col.type);
  if (isFixedPoint) {
    const precision = col.type === WIRE_TYPE.INT64 ? 18 : col.type === WIRE_TYPE.INT128 ? 38 : col.type === WIRE_TYPE.SHORT ? 4 : 9;
    return { sqlType: `DECIMAL(${precision},${-scale})` };
  }
  switch (col.type) {
    case WIRE_TYPE.SHORT: return { sqlType: "INT" };
    case WIRE_TYPE.LONG: return { sqlType: "INT" };
    case WIRE_TYPE.INT64: return { sqlType: "BIGINT" };
    case WIRE_TYPE.INT128: return { sqlType: "DECIMAL(38,0)" };
    case WIRE_TYPE.FLOAT: case WIRE_TYPE.DOUBLE: case WIRE_TYPE.D_FLOAT:
    case WIRE_TYPE.DEC16: case WIRE_TYPE.DEC34: return { sqlType: "FLOAT", lossyNumeric: true };
    case WIRE_TYPE.TYPE_DATE: return { sqlType: "DATE" };
    case WIRE_TYPE.TYPE_TIME: case WIRE_TYPE.TIME_TZ: case WIRE_TYPE.TIME_TZ_EX: return { sqlType: "TIME" };
    case WIRE_TYPE.TIMESTAMP: case WIRE_TYPE.TIMESTAMP_TZ: case WIRE_TYPE.TIMESTAMP_TZ_EX: return { sqlType: "DATETIME2" };
    case WIRE_TYPE.BOOLEAN: return { sqlType: "BIT" };
    case WIRE_TYPE.TEXT: case WIRE_TYPE.VARYING: {
      const len = col.length ?? 255;
      return { sqlType: `NVARCHAR(${Math.min(Math.max(len, 1), 4000)})` };
    }
    case WIRE_TYPE.BLOB:
      return col.subType === 1 ? { sqlType: "NVARCHAR(MAX)" } : { sqlType: "VARBINARY(MAX)" };
    default:
      return { sqlType: "NVARCHAR(MAX)" };
  }
}

const FIELD_CATALOG_SQL = `
  SELECT
    TRIM(rf.RDB$FIELD_NAME)   AS FIELD_NAME,
    f.RDB$FIELD_TYPE          AS FIELD_TYPE,
    f.RDB$FIELD_SUB_TYPE      AS SUB_TYPE,
    f.RDB$FIELD_LENGTH        AS FIELD_LENGTH,
    f.RDB$FIELD_PRECISION     AS FIELD_PRECISION,
    f.RDB$FIELD_SCALE         AS FIELD_SCALE,
    rf.RDB$NULL_FLAG          AS NULL_FLAG,
    TRIM(cs.RDB$CHARACTER_SET_NAME) AS CHARSET
  FROM RDB$RELATION_FIELDS rf
  JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
  LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = f.RDB$CHARACTER_SET_ID
  WHERE rf.RDB$RELATION_NAME = ?
  ORDER BY rf.RDB$FIELD_POSITION`;

export async function tableColumnsFirebird(endpoint: FirebirdEndpoint, _schema: string, table: string): Promise<SourceColumn[]> {
  return withFirebird(endpoint, async (db) => {
    const rows = await db.queryAsync<FbFieldRow>(FIELD_CATALOG_SQL, [table]);
    if (rows.length === 0) throw new ApiError(404, "SOURCE_TABLE_NOT_FOUND", `Tabela "${table}" não encontrada no Firebird restaurado`);
    return rows.map((row) => {
      const m = mapFirebirdType(row);
      return {
        originalName: row.FIELD_NAME,
        sqlName: sqlIdentifier(row.FIELD_NAME),
        sqlType: m.sqlType,
        nullable: row.NULL_FLAG !== 1,
        ...(m.lossyNumeric ? { lossyNumeric: true } : {}),
      };
    });
  });
}

export function safeStatementFirebird(query: string): string {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);
  return validated.statement;
}

export async function queryColumnsFirebird(endpoint: FirebirdEndpoint, query: string): Promise<SourceColumn[]> {
  const statement = safeStatementFirebird(query);
  try {
    return await withFirebird(endpoint, async (db) => {
      // Sem TOP 0 nativo: FIRST 0 é o equivalente Firebird (dialeto 3) para sondar forma sem ler linhas.
      const result = await db.queryAsync<Record<string, unknown>>(`SELECT FIRST 0 * FROM (${statement}) cw_source_probe`, [], { withMeta: true });
      return result.fields.map((col) => {
        const name = col.field ?? col.alias ?? "?";
        const m = mapFirebirdWireType({ type: col.type, subType: col.subType ?? null, length: col.length ?? null, scale: col.scale ?? 0 });
        return { originalName: name, sqlName: sqlIdentifier(name), sqlType: m.sqlType, nullable: col.nullable !== false, ...(m.lossyNumeric ? { lossyNumeric: true } : {}) };
      });
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Sem isto, qualquer erro do driver/engine Firebird (procedimento inexistente, tipo de parâmetro
    // incompatível, erro de lógica dentro do procedimento) virava um "Erro interno do servidor" genérico
    // (500, so com um errorId) — o unico jeito de saber o que aconteceu era olhar o Sentry. Este endpoint
    // já exige ADMIN, e o erro do Firebird é sobre a CONSULTA do usuário, não sobre infra (host/senha),
    // então é seguro mostrar de volta, igual já se faz para Postgres/MSSQL (que também nunca traduziam,
    // só nunca lançavam esse tipo de erro para uma probe de SELECT simples).
    const message = e instanceof Error ? e.message : String(e);
    throw new ApiError(400, "FIREBIRD_QUERY_ERROR", message);
  }
}

export async function executeFirebirdReadOnly(endpoint: FirebirdEndpoint, query: string, _timeout = 30, limit = 10000, offset = 0, normalize = false) {
  const statement = safeStatementFirebird(query);
  const clampedLimit = Math.min(Math.max(limit, 1), 10000);
  return withFirebird(endpoint, async (db) => {
    const started = Date.now();
    // FIRST/SKIP pede clampedLimit+1 para saber se ha mais (mesmo principio de hasMore honesto do resto do projeto).
    const rows = await db.queryAsync<Record<string, unknown>>(`SELECT FIRST ${clampedLimit + 1} SKIP ${Math.max(offset, 0)} * FROM (${statement}) cw_extract_result`);
    const truncated = rows.length > clampedLimit;
    const sliced = truncated ? rows.slice(0, clampedLimit) : rows;
    void normalize; // normalizacao de tipo (ColumnKind) fica para quando este provider entrar no contrato de resultado/OData
    return {
      columns: sliced.length ? Object.keys(sliced[0]!) : [],
      rows: sliced,
      rowCount: sliced.length,
      truncated,
      executionTimeMs: Date.now() - started,
    };
  });
}

export async function* streamFirebirdRows(endpoint: FirebirdEndpoint, query: string, batchSize = 1000): AsyncGenerator<Record<string, unknown>[]> {
  const statement = safeStatementFirebird(query);
  const db = await Firebird.attachAsync(options(endpoint));
  try {
    // queryStream ja e um Readable object-mode com backpressure (driver nativo) — nao precisamos do manual
    // pause/resume que mssql.ts faz a mao, o driver Firebird ja entrega isso pronto.
    const stream = db.queryStream(statement);
    let batch: Record<string, unknown>[] = [];
    for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
      batch.push(row);
      if (batch.length >= batchSize) { yield batch; batch = []; }
    }
    if (batch.length > 0) yield batch;
  } finally {
    await db.detachAsync().catch(() => undefined);
  }
}

/** Relogio do Firebird efêmero (nosso próprio container, não o ERP de origem — o backup é uma foto estática). */
export async function sourceClockFirebird(endpoint: FirebirdEndpoint): Promise<Date> {
  return withFirebird(endpoint, async (db) => {
    const r = await db.queryAsync<{ NOW: Date }>("SELECT CURRENT_TIMESTAMP AS NOW FROM RDB$DATABASE");
    return r[0]!.NOW;
  });
}

export function quotedFirebirdTable(table: string): string {
  return `"${table.replaceAll('"', '""')}"`;
}
