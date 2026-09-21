/**
 * Parsers de tipo do `pg` para LEITURA de resultados entregues ao cliente (ENT-06).
 *
 * O parser padrao do `pg` transforma DATE/TIMESTAMP/TIMESTAMPTZ em `Date` JS:
 *  - DATE e TIMESTAMP (sem fuso) viram "meia-noite/hora LOCAL do processo Node": o valor entregue depende do fuso do
 *    servidor e cai numa lacuna de horario de verao (ex.: 02:30 em 2026-03-08 no fuso de Nova York vira 03:30);
 *  - microssegundos sao truncados para milissegundos;
 *  - 'infinity' / '-infinity' viram `Invalid Date` (serializados como null).
 * Entregar o TEXTO do banco elimina os tres problemas. Depois, `result.ts` formata o texto (nunca por `Date`).
 *
 * Deliberadamente NAO e global (`types.setTypeParser`) nem do pool: `PgStorageConnection.serverNow()` e o codigo de
 * deteccao de exclusoes dependem de `Date` (relogio do storage). Use `types: PG_STRING_TYPES` por consulta.
 */
import { types } from "pg";

const TEXT_OIDS = new Set<number>([1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */]);
const identity = (v: string) => v;

export const PG_STRING_TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (TEXT_OIDS.has(oid)) return identity;
    return types.getTypeParser(oid, format as never);
  },
};
