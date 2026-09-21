import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ table: null as null | { id: string }, last: null as null | { originalFilename: string } }));
vi.mock("@/server/db", () => ({ prisma: { datasetTable: { findUnique: vi.fn(async () => m.table) }, upload: { findFirst: vi.fn(async () => m.last) } } }));
import { tableNameCollisionWarning } from "./name-collision";

beforeEach(() => { m.table = null; m.last = null; });

describe("tableNameCollisionWarning", () => {
  it("o caso real: Obras.csv depois de obras.csv (mesma tabela) → avisa nomeando os dois", async () => {
    m.table = { id: "t1" }; m.last = { originalFilename: "obras.csv" };
    const w = await tableNameCollisionWarning("d1", "Obras.csv");
    expect(w).toContain('"Obras.csv"');
    expect(w).toContain('"obras.csv"');
    expect(w).toContain('"obras"');
  });
  it("mesmo nome de sempre: sem aviso", async () => {
    m.table = { id: "t1" }; m.last = { originalFilename: "obras.csv" };
    expect(await tableNameCollisionWarning("d1", "obras.csv")).toBeNull();
  });
  it("tabela nova ou sem upload anterior: sem aviso", async () => {
    expect(await tableNameCollisionWarning("d1", "obras.csv")).toBeNull();
    m.table = { id: "t1" };
    expect(await tableNameCollisionWarning("d1", "obras.csv")).toBeNull();
  });
  it("tabela alimentada por arquivo de nome diferente (renomeada de propósito): sem aviso", async () => {
    m.table = { id: "t1" }; m.last = { originalFilename: "cadastro_antigo.csv" };
    expect(await tableNameCollisionWarning("d1", "obras.csv")).toBeNull();
  });
  it("extensão diferente do mesmo nome não é colisão de caixa, é o mesmo arquivo em outro formato: avisa só se o nome original difere", async () => {
    m.table = { id: "t1" }; m.last = { originalFilename: "obras.xlsx" };
    expect(await tableNameCollisionWarning("d1", "obras.csv")).toContain('"obras.xlsx"');
  });
});
