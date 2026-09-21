/**
 * Parsers de tipo do cliente pg usados SOMENTE na conexao de extracao de fontes (nunca globais: `pg.types.setTypeParser`
 * mudaria as consultas ao vivo e o storage). Devolvem o TEXTO cru do Postgres para tudo que o parser padrao do `pg`
 * deformaria (FON-03/04/10): datas dependem do fuso do processo, floats viram Number (NaN, 1e300), json/jsonb viram
 * objetos, bytea vira Buffer, interval vira objeto, arrays viram arrays JS (numeric[] via parseFloat).
 */
import { types as pgTypes } from "pg";

const raw = (v: string) => v;

/** date, timestamp, timestamptz */
export const TEMPORAL_OIDS = [1082, 1114, 1184];
/** float4, float8 */
export const FLOAT_OIDS = [700, 701];
/** json, jsonb, bytea, interval */
export const STRUCTURED_OIDS = [114, 3802, 17, 1186];
/** arrays que o pg converte em arrays JS (perdendo NUL, precisao, formato): bool[], bytea[], int[], int8[], float[], numeric[], texto[], datas[], interval[], json[] ... */
export const ARRAY_OIDS = [
  651, 199, 3807, 3907, 2951, 791, 1000, 1001, 1005, 1007, 1008, 1009, 1014, 1015, 1016, 1017, 1021, 1022, 1028,
  1040, 1041, 1115, 1182, 1183, 1185, 1187, 1231, 1270,
];

const RAW = new Set<number>([...TEMPORAL_OIDS, ...FLOAT_OIDS, ...STRUCTURED_OIDS, ...ARRAY_OIDS]);

export const sourceTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (RAW.has(oid)) return raw;
    return pgTypes.getTypeParser(oid, format);
  },
};

/** Sessao de leitura da origem: fuso, formato de interval e bytea fixos (independe da configuracao do servidor da origem). */
export const SOURCE_SESSION_SETTINGS = [
  "SET TimeZone TO 'UTC'",
  "SET IntervalStyle TO 'iso_8601'",
  "SET bytea_output TO 'hex'",
  "SET extra_float_digits TO 3",
  "SET DateStyle TO 'ISO, YMD'",
];
