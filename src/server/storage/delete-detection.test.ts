import { describe, expect, it } from "vitest";
import {
  deleteMissingKeysSql, keysCheckExceeds, mergeRemovalPlan, missingKeysWhere, scopeJoin, tombstoneTableName,
  KEYS_CHECK_MAX_RATIO, KEYS_CHECK_RATIO_MIN_LIVE,
} from "./delete-detection";

const pgQ = (s: string) => `"${s}"`;
const msQ = (s: string) => `[${s}]`;

function plan(dialect: "pg" | "mssql", o: { fullSnapshot?: boolean; scopeColumns?: string[] | null }) {
  const q = dialect === "pg" ? pgQ : msQ;
  return mergeRemovalPlan({
    dialect, q, qTgt: `${q("s")}.${q("tgt")}`, qStg: `${q("s")}.${q("stg")}`, qTomb: `${q("s")}.${q("cw_tomb_tgt")}`,
    key: q("id"), qDeletedAt: q("cw_deleted_at"), now: dialect === "pg" ? "now()" : "SYSUTCDATETIME()",
    fullSnapshot: !!o.fullSnapshot, scopeColumns: o.scopeColumns ?? null,
  });
}

describe.each(["pg", "mssql"] as const)("mergeRemovalPlan (%s)", (d) => {
  it("sem escopo e sem fullSnapshot: nada e removido (delta parcial preserva tudo)", () => {
    const p = plan(d, {});
    expect(p.active).toBe(false);
    expect(p.copyJoin).toBe("");
    expect(p.copyWhere).toContain("NOT EXISTS");
    expect(p.copyWhere).not.toContain("1 = 0");
  });

  it("escopo: copia so quem NAO esta no escopo (inclui escopo nulo); remove quem esta", () => {
    const q = d === "pg" ? pgQ : msQ;
    const p = plan(d, { scopeColumns: ["a", "b"] });
    expect(p.active).toBe(true);
    // tuplas de escopo da staging so com todas as colunas nao nulas
    expect(p.copyJoin).toContain(`WHERE ${q("a")} IS NOT NULL AND ${q("b")} IS NOT NULL`);
    expect(p.copyJoin).toContain(`sc.${q("a")} = t.${q("a")} AND sc.${q("b")} = t.${q("b")}`);
    // preserva: escopo sem par na staging (inclui tuplas com NULL, que nunca casam no join)
    expect(p.copyWhere).toContain(`sc.${q("a")} IS NULL`);
    // remove: escopo presente
    expect(p.insert).toContain(`sc.${q("a")} IS NOT NULL`);
    expect(p.insert).toContain("COALESCE(t.");
    expect(p.insert).toContain("NOT EXISTS (SELECT 1 FROM");
  });

  it("fullSnapshot: nenhuma ausente e copiada; todas viram lapide", () => {
    const p = plan(d, { fullSnapshot: true, scopeColumns: ["a"] });
    expect(p.active).toBe(true);
    expect(p.copyWhere).toContain("1 = 0");
    expect(p.copyJoin).toBe(""); // fullSnapshot dispensa o escopo
    expect(p.insert).toContain("cw_tomb_tgt");
    expect(p.insert).not.toContain("sc.");
  });

  it("revive apaga a lapide da chave que voltou na staging", () => {
    const p = plan(d, { scopeColumns: ["a"] });
    expect(p.revive).toContain("cw_tomb_tgt");
    expect(p.revive).toMatch(/EXISTS \(SELECT 1 FROM .*stg/);
    if (d === "mssql") expect(p.revive).toMatch(/^DELETE k FROM/);
  });
});

describe("scopeJoin", () => {
  it("usa JOIN em tuplas DISTINCT (nao EXISTS correlacionado)", () => {
    const j = scopeJoin(pgQ, ["a"], '"s"."stg"');
    expect(j.join).toContain("SELECT DISTINCT");
    expect(j.join.startsWith("LEFT JOIN")).toBe(true);
  });
});

describe("verificacao de chaves", () => {
  it("guarda cw_synced_at < before e NOT EXISTS na lista de chaves", () => {
    const w = missingKeysWhere({ q: pgQ, qKeys: '"s"."cw_keys_x"', key: '"id"', beforeParam: "$1::timestamp" });
    expect(w).toContain('t."cw_synced_at" < $1::timestamp');
    expect(w).toContain('NOT EXISTS (SELECT 1 FROM "s"."cw_keys_x" k WHERE k."id" = t."id")');
  });

  it("pg: DELETE + lapide na MESMA instrucao (CTE com RETURNING)", () => {
    const sql = deleteMissingKeysSql({ dialect: "pg", q: pgQ, qTgt: '"s"."t"', qTomb: '"s"."cw_tomb_t"', key: '"id"', where: "W" });
    expect(sql).toContain('WITH del AS (DELETE FROM "s"."t" t WHERE W RETURNING t."id" AS k)');
    expect(sql).toContain('INSERT INTO "s"."cw_tomb_t"');
  });

  it("mssql: DELETE ... OUTPUT DELETED.<chave> INTO lapide", () => {
    const sql = deleteMissingKeysSql({ dialect: "mssql", q: msQ, qTgt: "[s].[t]", qTomb: "[s].[cw_tomb_t]", key: "[id]", where: "W" });
    expect(sql).toContain("DELETE t OUTPUT DELETED.[id], SYSUTCDATETIME() INTO [s].[cw_tomb_t]");
  });

  it("limite de proporcao: acima aborta; tabela minuscula nao avalia; zero nunca aborta", () => {
    expect(keysCheckExceeds({ candidates: 40, live: 100 }, KEYS_CHECK_MAX_RATIO)).toBe(true);
    expect(keysCheckExceeds({ candidates: 30, live: 100 }, KEYS_CHECK_MAX_RATIO)).toBe(false);
    expect(keysCheckExceeds({ candidates: 5, live: KEYS_CHECK_RATIO_MIN_LIVE - 1 }, KEYS_CHECK_MAX_RATIO)).toBe(false);
    expect(keysCheckExceeds({ candidates: 0, live: 1000 }, KEYS_CHECK_MAX_RATIO)).toBe(false);
  });
});

describe("tombstoneTableName", () => {
  it("prefixo cw_tomb_ e limite de 63 caracteres com hash estavel", () => {
    expect(tombstoneTableName("orders")).toBe("cw_tomb_orders");
    const long = "x".repeat(80);
    const n = tombstoneTableName(long);
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toBe(tombstoneTableName(long));
    expect(n).not.toBe(tombstoneTableName("x".repeat(81)));
  });
});
