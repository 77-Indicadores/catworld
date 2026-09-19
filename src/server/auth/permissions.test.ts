import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  datasets: [] as { id: string; projectId: string; schemaName: string; storageServerId: string | null; active: boolean }[],
  grants: [] as { scopeType: string; projectId?: string; datasetId?: string; permission: string }[],
}));

vi.mock("@/server/db", () => ({
  prisma: {
    dataset: {
      findMany: async ({ where }: { where: { active?: boolean; projectId?: string } }) =>
        db.datasets.filter((d) => (where.active === undefined || d.active === where.active) && (!where.projectId || d.projectId === where.projectId)),
      findUnique: async ({ where }: { where: { id: string; active?: boolean } }) =>
        db.datasets.find((d) => d.id === where.id && (where.active === undefined || d.active === where.active)) ?? null,
    },
    accessGrant: { findMany: async () => db.grants },
  },
}));

import { resolveQueryScope } from "./permissions";
import type { Actor } from "./actor";

const P1 = "p1", P2 = "p2";
const A = { id: "A", projectId: P1, schemaName: "ds_a", storageServerId: null, active: true };
const B = { id: "B", projectId: P2, schemaName: "ds_b", storageServerId: null, active: true };
const C = { id: "C", projectId: P1, schemaName: "ds_c", storageServerId: null, active: true };

const user = (role: string): Actor => ({ type: "user", id: "u1", role, principal: "cw_u_1" });
const token: Actor = { type: "token", id: "t1", role: "TOKEN", principal: "cw_t_1" };

beforeEach(() => {
  db.datasets = [A, B, C];
  db.grants = [];
});

describe("resolveQueryScope", () => {
  it("usuario SEM grant nenhum: 403 no dataset, no projeto e sem escopo", async () => {
    await expect(resolveQueryScope(user("VIEWER"), { datasetId: "A" })).rejects.toMatchObject({ status: 403 });
    await expect(resolveQueryScope(user("VIEWER"), { projectId: P1 })).rejects.toMatchObject({ status: 403 });
    await expect(resolveQueryScope(user("VIEWER"), {})).rejects.toMatchObject({ status: 403 });
  });

  it("token com grant so no dataset A: le A, NAO le B, e sem escopo so enxerga A", async () => {
    db.grants = [{ scopeType: "DATASET", datasetId: "A", permission: "READ" }];
    const ok = await resolveQueryScope(token, { datasetId: "A" });
    expect(ok.datasets.map((d) => d.id)).toEqual(["A"]);
    await expect(resolveQueryScope(token, { datasetId: "B" })).rejects.toMatchObject({ status: 403 });
    const free = await resolveQueryScope(token, {});
    expect(free.datasets).toEqual([]);
    expect(free.accessible.map((d) => d.id)).toEqual(["A"]); // o papel de banco sera limitado a ds_a
  });

  it("grant de PROJETO alcanca os datasets do projeto e o escopo de projeto filtra", async () => {
    db.grants = [{ scopeType: "PROJECT", projectId: P1, permission: "READ" }];
    const r = await resolveQueryScope(token, { projectId: P1 });
    expect(r.datasets.map((d) => d.id).sort()).toEqual(["A", "C"]);
    await expect(resolveQueryScope(token, { projectId: P2 })).rejects.toMatchObject({ status: 403 });
  });

  it("grant DATASET dentro de projeto: o escopo de projeto so devolve o permitido", async () => {
    db.grants = [{ scopeType: "DATASET", datasetId: "C", permission: "READ" }];
    const r = await resolveQueryScope(token, { projectId: P1 });
    expect(r.datasets.map((d) => d.id)).toEqual(["C"]);
  });

  it("grant GLOBAL le tudo", async () => {
    db.grants = [{ scopeType: "GLOBAL", permission: "READ" }];
    expect((await resolveQueryScope(token, {})).accessible).toHaveLength(3);
  });

  it("dataset inexistente/inativo: 404; projeto vazio: 404", async () => {
    db.grants = [{ scopeType: "GLOBAL", permission: "READ" }];
    await expect(resolveQueryScope(token, { datasetId: "Z" })).rejects.toMatchObject({ status: 404 });
    await expect(resolveQueryScope(token, { projectId: "vazio" })).rejects.toMatchObject({ status: 404 });
  });

  it("admin: enxerga tudo e, sem escopo, fica sem restricao", async () => {
    const r = await resolveQueryScope(user("ADMIN"), {});
    expect(r.unrestricted).toBe(true);
    expect(r.accessible).toHaveLength(3);
    expect((await resolveQueryScope(user("ADMIN"), { datasetId: "B" })).datasets[0]!.id).toBe("B");
  });

  it("DATA_MANAGER nao ganha acesso so pelo papel: precisa de grant (igual a canAccess)", async () => {
    await expect(resolveQueryScope(user("DATA_MANAGER"), { datasetId: "A" })).rejects.toMatchObject({ status: 403 });
  });
});
