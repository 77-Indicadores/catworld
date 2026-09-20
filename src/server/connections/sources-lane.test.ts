import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  job: { findMany: vi.fn(), create: vi.fn() },
  datasetSource: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn() }));
vi.mock("./postgres", () => ({ queryColumns: vi.fn(), quotedPgTable: vi.fn(), streamPostgresRows: vi.fn(), tableColumns: vi.fn() }));
vi.mock("./mssql", () => ({ queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { LONG_RUN_MS, LONG_ROWS_HINT, classifySourceLane, laneWeight, nextAvgRunMs, queueSourceRefresh } from "./sources";

const base = { sourceKind: "query", deltaColumn: null, lastDeltaValue: null, keyColumn: null } as const;

describe("classifySourceLane", () => {
  it("reconciliação é sempre longa, mesmo com histórico curto", () => {
    expect(classifySourceLane({ ...base, avgRunMs: 4000 }, true)).toBe("long");
  });

  it("com histórico manda a duração observada: a incremental da ADL (~5 min) é LONGA; cópia de tabela pequena (~4 s) é RÁPIDA", () => {
    expect(classifySourceLane({ ...base, avgRunMs: 323_000 }, false)).toBe("long");
    expect(classifySourceLane({ ...base, sourceKind: "table", avgRunMs: 4_000 }, false)).toBe("fast");
  });

  it("o limiar é LONG_RUN_MS (>= é longa)", () => {
    expect(classifySourceLane({ ...base, avgRunMs: LONG_RUN_MS - 1 }, false)).toBe("fast");
    expect(classifySourceLane({ ...base, avgRunMs: LONG_RUN_MS }, false)).toBe("long");
  });

  it("o histórico vence o tamanho: tabela grande porém rápida continua rápida", () => {
    expect(classifySourceLane({ ...base, avgRunMs: 10_000, lastRowCount: 5_000_000n }, false)).toBe("fast");
  });

  it("sem histórico usa o tamanho da última carga (a ADL, 828 mil linhas, já nasce longa; tabela pequena, rápida)", () => {
    expect(classifySourceLane({ ...base, avgRunMs: null, lastRowCount: 828_672n }, false)).toBe("long");
    expect(classifySourceLane({ ...base, avgRunMs: null, lastRowCount: BigInt(LONG_ROWS_HINT) }, false)).toBe("long");
    expect(classifySourceLane({ ...base, avgRunMs: null, lastRowCount: BigInt(LONG_ROWS_HINT - 1) }, false)).toBe("fast");
    expect(classifySourceLane({ ...base, sourceKind: "table", avgRunMs: null, lastRowCount: 120 }, false)).toBe("fast");
  });

  it("sem NENHUM dado (fonte nova) cai na regra antiga: janelada/consulta = rápida, tabela sem delta = longa", () => {
    expect(classifySourceLane({ ...base }, false)).toBe("fast");
    expect(classifySourceLane({ ...base, sourceKind: "table" }, false)).toBe("long");
    expect(classifySourceLane({ ...base, sourceKind: "table", deltaColumn: "upd", lastDeltaValue: "2026-01-01", keyColumn: "id" }, false)).toBe("fast");
  });

  it("laneWeight: rápida = peso 0, longa = peso 2", () => {
    expect(laneWeight("fast")).toBe(0);
    expect(laneWeight("long")).toBe(2);
  });
});

describe("nextAvgRunMs (média móvel)", () => {
  it("a 1ª medição vira a média", () => expect(nextAvgRunMs(null, 12_345)).toBe(12_345));
  it("pondera 70% do histórico e 30% da rodada nova", () => expect(nextAvgRunMs(10_000, 20_000)).toBe(13_000));
  it("uma rodada anômala não vira a fonte para 'longa' de uma vez, mas várias sim", () => {
    let avg = nextAvgRunMs(null, 4_000);
    avg = nextAvgRunMs(avg, 600_000); // 1 anomalia
    expect(avg).toBeLessThan(200_000);
    for (let i = 0; i < 5; i++) avg = nextAvgRunMs(avg, 600_000);
    expect(avg).toBeGreaterThanOrEqual(LONG_RUN_MS);
  });
  it("nunca devolve negativo nem estoura o inteiro de 32 bits", () => {
    expect(nextAvgRunMs(null, -5)).toBe(0);
    expect(nextAvgRunMs(null, 9e12)).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe("queueSourceRefresh grava o peso da faixa no job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.job.findMany.mockResolvedValue([]);
    prismaMock.job.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "j1", ...a.data }));
    prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
  });
  const enqueue = async (src: Record<string, unknown>, reconciliation = false) => {
    prismaMock.datasetSource.findUniqueOrThrow.mockResolvedValue({ ...base, avgRunMs: null, lastRowCount: null, dataset: { storageServerId: null }, ...src });
    await queueSourceRefresh("11111111-1111-1111-1111-111111111111", { reconciliation });
    return (prismaMock.job.create.mock.calls.at(-1)![0] as { data: { weight: number; storageServerId: string } }).data;
  };

  it("fonte longa (histórico de 5 min) entra com peso 2; rápida com peso 0", async () => {
    expect((await enqueue({ avgRunMs: 323_000 })).weight).toBe(2);
    expect((await enqueue({ avgRunMs: 4_000 })).weight).toBe(0);
  });

  it("reconciliação entra com peso 2 mesmo numa fonte rápida", async () => {
    expect((await enqueue({ avgRunMs: 4_000 }, true)).weight).toBe(2);
  });

  it("mantém o bucket de storage (o limite por storage continua valendo em ambas as faixas)", async () => {
    expect((await enqueue({ avgRunMs: 4_000 })).storageServerId).toBe("__default__");
    expect((await enqueue({ avgRunMs: 4_000, dataset: { storageServerId: "s-1" } })).storageServerId).toBe("s-1");
  });
});
