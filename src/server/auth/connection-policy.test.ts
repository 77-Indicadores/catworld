import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  datasets: [] as { id: string; projectId: string; schemaName: string; storageServerId: string | null; active: boolean }[],
  grants: [] as { scopeType: string; projectId?: string; datasetId?: string; permission: string }[],
  sources: [] as { connectionId: string; projectId: string }[],
}));

vi.mock("@/server/db", () => ({
  prisma: {
    dataset: { findMany: async () => db.datasets.filter((d) => d.active), findUnique: async () => null },
    accessGrant: { findMany: async () => db.grants },
    datasetSource: {
      findFirst: async ({ where }: { where: { connectionId: string; dataset: { projectId: string } } }) =>
        db.sources.find((s) => s.connectionId === where.connectionId && s.projectId === where.dataset.projectId) ?? null,
    },
  },
}));

import { assertCanUseConnection, canSeeDataset } from "./permissions";
import { assertSqlSchemasAllowed, referencedSchemas } from "@/server/sql-contract/references";
import type { Actor } from "./actor";

const A = { id: "A", projectId: "p1", schemaName: "ds_a", storageServerId: null, active: true };
const B = { id: "B", projectId: "p1", schemaName: "ds_b", storageServerId: null, active: true };
const C = { id: "C", projectId: "p2", schemaName: "ds_c", storageServerId: null, active: true };
const user = (role: string): Actor => ({ type: "user", id: "u1", role, principal: "cw_u_1" });
const token: Actor = { type: "token", id: "t1", role: "TOKEN", principal: "cw_t_1" };

beforeEach(() => {
  db.datasets = [A, B, C];
  db.grants = [];
  db.sources = [];
});

describe("assertCanUseConnection (quem cria fonte nao pode pular para uma conexao nova)", () => {
  it("ADMIN e DATA_MANAGER: livres", async () => {
    await expect(assertCanUseConnection(user("ADMIN"), "conn-x", A)).resolves.toBeUndefined();
    await expect(assertCanUseConnection(user("DATA_MANAGER"), "conn-x", A)).resolves.toBeUndefined();
  });
  it("token / ANALYST / VIEWER: 403 em conexao que o projeto nao usa", async () => {
    await expect(assertCanUseConnection(token, "conn-x", A)).rejects.toMatchObject({ status: 403, code: "CONNECTION_FORBIDDEN" });
    await expect(assertCanUseConnection(user("ANALYST"), "conn-x", A)).rejects.toMatchObject({ code: "CONNECTION_FORBIDDEN" });
  });
  it("token: OK numa conexao que o PROJETO ja usa (setups existentes continuam funcionando)", async () => {
    db.sources = [{ connectionId: "conn-x", projectId: "p1" }];
    await expect(assertCanUseConnection(token, "conn-x", A)).resolves.toBeUndefined();
    await expect(assertCanUseConnection(token, "conn-x", B)).resolves.toBeUndefined(); // outro dataset do mesmo projeto
  });
  it("conexao usada so em OUTRO projeto nao vale", async () => {
    db.sources = [{ connectionId: "conn-x", projectId: "p2" }];
    await expect(assertCanUseConnection(token, "conn-x", A)).rejects.toMatchObject({ status: 403 });
  });
});

describe("canSeeDataset (mesma regra das listagens)", () => {
  it("sem grant: nao ve; com grant no dataset: so ele; GLOBAL: todos; ADMIN e DATA_MANAGER: todos", async () => {
    expect(await canSeeDataset(token, "A")).toBe(false);
    db.grants = [{ scopeType: "DATASET", datasetId: "A", permission: "READ" }];
    expect(await canSeeDataset(token, "A")).toBe(true);
    expect(await canSeeDataset(token, "B")).toBe(false);
    db.grants = [{ scopeType: "GLOBAL", permission: "READ" }];
    expect(await canSeeDataset(token, "C")).toBe(true);
    db.grants = [];
    expect(await canSeeDataset(user("ADMIN"), "C")).toBe(true);
    expect(await canSeeDataset(user("DATA_MANAGER"), "C")).toBe(true);
  });
});

describe("referencedSchemas", () => {
  it("acha schema em FROM, JOIN, subconsulta, CTE e colchetes", () => {
    expect(referencedSchemas("SELECT * FROM ds_a.t x JOIN [ds_b].[u] y ON x.id=y.id").sort()).toEqual(["ds_a", "ds_b"]);
    expect(referencedSchemas("WITH c AS (SELECT * FROM ds_b.u) SELECT * FROM c")).toEqual(["ds_b"]);
    expect(referencedSchemas("SELECT * FROM t WHERE id IN (SELECT id FROM DS_B.u)")).toEqual(["ds_b"]);
    expect(referencedSchemas("SELECT * FROM db1.dbo.t")).toEqual(["dbo"]);
  });
  it("sem schema (nome solto, CTE) nao entra", () => {
    expect(referencedSchemas("SELECT * FROM vendas")).toEqual([]);
  });
  it("sintaxe fora do T-SQL cai na varredura por FROM/JOIN", () => {
    expect(referencedSchemas('SELECT a::text FROM "ds_b"."u" JOIN ds_c.v ON true').sort()).toEqual(["ds_b", "ds_c"]);
  });
});

describe("assertSqlSchemasAllowed (SQL de derivada nao alcanca dado que o autor nao le)", () => {
  it("ADMIN: livre", async () => {
    await expect(assertSqlSchemasAllowed(user("ADMIN"), "SELECT * FROM ds_c.t", "ds_a")).resolves.toBeUndefined();
  });
  it("proprio schema e schemas legiveis passam (derivada que junta dois datasets continua valendo)", async () => {
    db.grants = [{ scopeType: "DATASET", datasetId: "A", permission: "WRITE" }, { scopeType: "DATASET", datasetId: "B", permission: "READ" }];
    await expect(assertSqlSchemasAllowed(token, "SELECT * FROM ds_a.t JOIN ds_b.u ON 1=1", "ds_a")).resolves.toBeUndefined();
    await expect(assertSqlSchemasAllowed(token, "SELECT * FROM vendas", "ds_a")).resolves.toBeUndefined();
  });
  it("schema de dataset sem permissao (ou de sistema) e barrado", async () => {
    db.grants = [{ scopeType: "DATASET", datasetId: "A", permission: "WRITE" }];
    await expect(assertSqlSchemasAllowed(token, "SELECT * FROM ds_c.folha", "ds_a")).rejects.toMatchObject({ status: 403, code: "SCHEMA_FORBIDDEN" });
    await expect(assertSqlSchemasAllowed(token, "WITH x AS (SELECT * FROM ds_b.u) SELECT * FROM x", "ds_a")).rejects.toMatchObject({ code: "SCHEMA_FORBIDDEN" });
    await expect(assertSqlSchemasAllowed(token, "SELECT * FROM information_schema.tables", "ds_a")).rejects.toMatchObject({ code: "SCHEMA_FORBIDDEN" });
  });
});
