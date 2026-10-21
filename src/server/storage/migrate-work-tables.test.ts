import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));
const { isWorkTable } = await import("./migrate");

describe("isWorkTable (tabelas de trabalho nunca sao migradas)", () => {
  it("staging de upload, mesclada, chaves, fonte, derivada e outra migracao", () => {
    for (const t of ["cw_stage_e1a2b3c4d5e6f7a8b9c0", "cw_mgd_e1a2b3c4d5e6f7a8b9c0", "cw_keys_abc", "cw_src_abc_rc", "__drv_vendas_1a2b3c4d", "cw_migstg_vendas_9f8e7d6c"]) {
      expect(isWorkTable(t)).toBe(true);
    }
  });
  it("tabelas do usuario passam, inclusive com cw no nome", () => {
    for (const t of ["vendas", "cw_vendas", "stage_cw", "produtos_cw_stage", "custos_2_10"]) expect(isWorkTable(t)).toBe(false);
  });
});
