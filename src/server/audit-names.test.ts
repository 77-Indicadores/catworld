import { describe, expect, it } from "vitest";
import { auditReferencedIds, displayResource } from "./audit-query";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("nomes na auditoria", () => {
  it("junta os ids citados no recurso e no token, sem repetir", () => {
    const ids = auditReferencedIds([
      { resourceId: `/api/v1/datasets/${A}/tables/${B}`, tokenId: null },
      { resourceId: A, tokenId: B },
      { resourceId: null, tokenId: null },
    ]);
    expect(ids.sort()).toEqual([A, B]);
  });
  it("troca o id pelo nome e mantém o id que não resolve", () => {
    const names = new Map([[A, "Vendas"]]);
    expect(displayResource(`/api/v1/datasets/${A}/tables/${B}`, "route", names)).toBe(`/api/v1/datasets/Vendas/tables/${B}`);
    expect(displayResource(null, "page", names)).toBe("page");
    expect(displayResource(null, null, names)).toBe("—");
  });
});
