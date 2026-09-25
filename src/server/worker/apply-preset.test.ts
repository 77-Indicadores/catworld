import { beforeEach, describe, expect, it, vi } from "vitest";

type P = { id: string; name: string; jobTypes: string[]; weights: number[]; concurrency: number; enabled: boolean; pollMs: number; duckdbMemoryLimit: string };

const db = vi.hoisted(() => ({
  profiles: [] as unknown[],
  settings: [] as { key: string; value: string }[],
  update: vi.fn((args: unknown) => ({ op: "profile.update", args })),
  create: vi.fn((args: unknown) => ({ op: "profile.create", args })),
  exec: vi.fn((sql: string, key: string, value: string) => ({ op: "setting", key, value })),
  transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock("@/server/db", () => ({
  prisma: {
    workerProfile: { findMany: vi.fn(async () => db.profiles), update: db.update, create: db.create },
    $queryRawUnsafe: vi.fn(async () => db.settings),
    $executeRawUnsafe: db.exec,
    $transaction: db.transaction,
  },
}));

import { PRESET_SETTING_KEYS, UnknownPresetError, applyPreset, readCurrentCapacity } from "./apply-preset";
import { PRESETS, LANES } from "@/lib/worker-presets";

const SYNC_TYPES = ["SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP"], UP_TYPES = ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"];
const prof = (over: Partial<P> & { name: string }): P => ({
  id: `id-${over.name}`, jobTypes: [], weights: [], concurrency: 1, enabled: true, pollMs: 2000, duckdbMemoryLimit: "1GB", ...over,
});
/** O estado de PRODUÇÃO hoje: 2 perfis padrão, 1 slot, sem faixas. */
const legacyProfiles = () => [
  prof({ name: "worker-sync", jobTypes: SYNC_TYPES, pollMs: 3000, duckdbMemoryLimit: "512MB" }),
  prof({ name: "worker-uploads", jobTypes: UP_TYPES, duckdbMemoryLimit: "2GB" }),
];
/** As 4 faixas já configuradas, com slots dados. */
const laneProfiles = (s: [number, number, number, number]) => LANES.map((l, i) => prof({ name: l.name, jobTypes: [...l.jobTypes], weights: [...l.weights], concurrency: s[i]! }));

const ops = () => (db.transaction.mock.calls[0]![0]) as { op: string; key?: string; value?: string; args: Record<string, unknown> & { data: Record<string, unknown>; where?: { id: string } } }[];

beforeEach(() => {
  vi.clearAllMocks();
  db.profiles = legacyProfiles();
  db.settings = [];
});

describe("readCurrentCapacity", () => {
  it("legado: slots dos 2 perfis, faixas desligadas, padrão do código nos tetos", async () => {
    const { capacity } = await readCurrentCapacity();
    expect(capacity.slots).toEqual({ "worker-sync": 1, "worker-uploads": 1 });
    expect(capacity.lanes).toBe(false);
    expect(capacity.max_heavy_jobs).toBe(2);
    expect(capacity.import_batch_delay_ms).toBe(200);
  });

  it("faixas configuradas: lanes = true e os 4 slots", async () => {
    db.profiles = laneProfiles([3, 1, 2, 1]);
    const { capacity } = await readCurrentCapacity();
    expect(capacity.lanes).toBe(true);
    expect(capacity.slots).toEqual({ "worker-sync": 3, "worker-sync-long": 1, "worker-uploads": 2, "worker-uploads-heavy": 1 });
  });

  it("valor salvo inválido cai no padrão (nunca NaN)", async () => {
    db.settings = [{ key: PRESET_SETTING_KEYS.max_heavy_jobs, value: "abc" }, { key: PRESET_SETTING_KEYS.import_batch_delay_ms, value: "0" }];
    const { capacity } = await readCurrentCapacity();
    expect(capacity.max_heavy_jobs).toBe(2);
    expect(capacity.import_batch_delay_ms).toBe(0);
  });
});

describe("applyPreset a partir do estado legado (o de produção hoje)", () => {
  it("numa ÚNICA transação: converte os 2 perfis em faixas leves, cria os 2 novos e grava os 3 tetos", async () => {
    const r = await applyPreset("equilibrado");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const o = ops();
    const updates = o.filter((x) => x.op === "profile.update"), creates = o.filter((x) => x.op === "profile.create");
    expect(updates.map((u) => u.args.where!.id)).toEqual(["id-worker-sync", "id-worker-uploads"]);
    // sync rápido: perde DERIVED_REFRESH (vai para o longo), ganha o filtro de pesos e 3 slots
    expect(updates[0]!.args.data).toMatchObject({ jobTypes: ["SOURCE_REFRESH", "METADATA_CLEANUP"], weights: [0, 1], concurrency: 3, enabled: true });
    expect(updates[1]!.args.data).toMatchObject({ jobTypes: UP_TYPES, weights: [0, 1], concurrency: 2 });
    expect(creates.map((c) => c.args.data.name)).toEqual(["worker-sync-long", "worker-uploads-heavy"]);
    expect(creates[0]!.args.data).toMatchObject({ jobTypes: ["SOURCE_REFRESH", "DERIVED_REFRESH", "MIGRATE_STORAGE_PROJECT", "MIGRATE_STORAGE_DATASET"], weights: [2], concurrency: 1, enabled: true });
    expect(creates[1]!.args.data).toMatchObject({ jobTypes: UP_TYPES, weights: [2], concurrency: 1 });
    expect(o.filter((x) => x.op === "setting").map((x) => [x.key, x.value])).toEqual([
      ["worker.max_heavy_jobs", "2"], ["worker.max_syncs_per_storage", "2"], ["worker.import_batch_delay_ms", "150"],
    ]);
    expect(r.restartProfiles).toEqual(["worker-sync", "worker-uploads"]);
    expect(r.newProfiles).toEqual(["worker-sync-long", "worker-uploads-heavy"]);
    expect(r.warnings).toEqual([]);
  });

  it("os perfis novos herdam poll e memória do 'irmão' da mesma família", async () => {
    await applyPreset("equilibrado");
    const [long, heavy] = ops().filter((x) => x.op === "profile.create").map((c) => c.args.data);
    expect(long).toMatchObject({ pollMs: 3000, duckdbMemoryLimit: "512MB" });   // de worker-sync
    expect(heavy).toMatchObject({ pollMs: 2000, duckdbMemoryLimit: "2GB" });    // de worker-uploads
  });

  it("a diferença devolvida mostra a estrutura, os slots e os novos perfis", async () => {
    const r = await applyPreset("alto");
    const keys = r.changes.map((c) => c.key);
    expect(keys).toContain("lanes");
    expect(keys).toContain("slots.worker-sync-long");
    expect(r.changes.find((c) => c.key === "slots.worker-uploads-heavy")).toMatchObject({ from: 0, to: 2, createsProfile: "worker-uploads-heavy" });
  });
});

describe("applyPreset com as faixas já configuradas", () => {
  it("só muda os slots que diferem; reinicia só esses; não cria nada", async () => {
    db.profiles = laneProfiles([3, 1, 2, 1]);            // = Equilibrado
    const r = await applyPreset("alto");                  // 5,2,3,2
    expect(db.create).not.toHaveBeenCalled();
    expect(r.newProfiles).toEqual([]);
    expect(r.restartProfiles.sort()).toEqual(["worker-sync", "worker-sync-long", "worker-uploads", "worker-uploads-heavy"]);
    const data = ops().filter((x) => x.op === "profile.update").map((x) => x.args.data.concurrency);
    expect(data).toEqual([5, 2, 3, 2]);
  });

  it("já no valor do preset: nada é atualizado nem reinicia (só regrava os tetos)", async () => {
    db.profiles = laneProfiles([3, 1, 2, 1]);
    const r = await applyPreset("equilibrado");
    expect(db.update).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(r.restartProfiles).toEqual([]);
    expect(db.exec).toHaveBeenCalledTimes(3);
  });

  it("um slot muda: só ele reinicia", async () => {
    db.profiles = laneProfiles([3, 1, 2, 1]).map((p) => (p.name === "worker-uploads" ? { ...p, concurrency: 1 } : p));
    const r = await applyPreset("equilibrado");
    expect(r.restartProfiles).toEqual(["worker-uploads"]);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("faixa parada (desabilitada): é habilitada SEM pedir reinício (o supervisor a sobe)", async () => {
    db.profiles = laneProfiles([3, 1, 2, 1]).map((p) => (p.name === "worker-sync-long" ? { ...p, enabled: false } : p));
    const r = await applyPreset("equilibrado");
    expect(ops().find((x) => x.op === "profile.update")!.args.data).toMatchObject({ enabled: true });
    expect(r.restartProfiles).toEqual([]);
  });
});

describe("applyPreset casos de borda", () => {
  it("perfil base ausente (ex.: worker-sync apagado): cria com os padrões, sem falhar", async () => {
    db.profiles = [legacyProfiles()[1]!];
    const r = await applyPreset("equilibrado");
    expect(r.newProfiles).toContain("worker-sync");
    const created = ops().filter((x) => x.op === "profile.create").map((c) => c.args.data.name);
    expect(created).toEqual(expect.arrayContaining(["worker-sync", "worker-sync-long", "worker-uploads-heavy"]));
  });

  it("perfil custom que já processa tudo continua contando na cobertura (nenhum aviso indevido)", async () => {
    db.profiles = [...legacyProfiles(), prof({ name: "worker-relatorios", jobTypes: ["SOURCE_REFRESH"], weights: [] })];
    const r = await applyPreset("economico");
    expect(r.warnings).toEqual([]);
  });

  it("preset desconhecido: erro claro e NADA é escrito", async () => {
    await expect(applyPreset("turbo")).rejects.toBeInstanceOf(UnknownPresetError);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("cada preset conhecido aplica sem erro e sem aviso", async () => {
    for (const p of PRESETS) {
      db.profiles = legacyProfiles();
      await expect(applyPreset(p.id)).resolves.toMatchObject({ preset: p.id, warnings: [] });
    }
  });
});
