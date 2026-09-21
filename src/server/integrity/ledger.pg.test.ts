// @vitest-environment node
/** Resumo do livro de integridade contra Postgres real (cw_load_ledger). Só com CW_TEST_PG_URL (banco DESCARTÁVEL; NUNCA produção). */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

const d = process.env.CW_TEST_PG_URL ? describe : describe.skip;
const DS = crypto.randomUUID();
const other = crypto.randomUUID();

d("summarizeIntegrity (Postgres real)", () => {
  afterAll(async () => { const { prisma } = await import("@/server/db"); await prisma.$executeRawUnsafe(`DELETE FROM cw_load_ledger WHERE dataset_id IN ($1::uuid, $2::uuid)`, DS, other); });

  async function add(dataset: string, table: string, outcome: "COMPLETED" | "FAILED", verdict: string, ageMin: number, detail?: object) {
    const { prisma } = await import("@/server/db");
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_load_ledger (kind, dataset_id, table_name, mode, outcome, verdict, expected_rows, parsed_rows, detail_json, created_at)
       VALUES ('upload', $1::uuid, $2, 'replace', $3, $4, 100, 40, $5, now() - ($6 || ' minutes')::interval)`,
      dataset, table, outcome, verdict, detail ? JSON.stringify(detail) : null, String(ageMin));
  }

  it("a última carga de cada tabela decide: falha sem recuperação alerta; falha seguida de OK encerra o alerta", async () => {
    await add(DS, "vendas", "FAILED", "FAILED", 60, { reasons: [{ message: "Foram lidas 40 linhas, mas a origem tem 100." }] });   // sem recuperação
    await add(DS, "estoque", "FAILED", "FAILED", 90);
    await add(DS, "estoque", "COMPLETED", "OK", 10);                                                                                 // recuperou depois
    await add(DS, "cadastro", "COMPLETED", "SUSPECT", 30, { reasons: [{ message: "Queda de 500 para 300 linhas." }] });
    await add(other, "vendas", "COMPLETED", "OK", 5);                                                                                // mesmo nome, outro dataset: independente
    const { summarizeIntegrity } = await import("./ledger");
    const s = await summarizeIntegrity(24);
    const mine = s.tablesNeedingAttention.filter((t) => t.tableName && ["vendas", "estoque", "cadastro"].includes(t.tableName));
    // (outros datasets do banco de teste podem ter linhas: filtra pelos nomes deste teste e confere pelo veredito)
    const byName = Object.fromEntries(mine.map((t) => [t.tableName!, t]));
    expect(byName.vendas?.verdict).toBe("FAILED");
    expect(byName.vendas?.reason).toContain("40 linhas");
    expect(byName.cadastro?.verdict).toBe("SUSPECT");
    expect(byName.estoque).toBeUndefined();                       // recuperou
    expect(s.loads).toBeGreaterThanOrEqual(5);
    expect(s.failed).toBeGreaterThanOrEqual(2);
  });
});
