// @vitest-environment node
/** Resumo do livro de integridade contra Postgres real (cw_load_ledger). Só com CW_TEST_PG_URL (banco DESCARTÁVEL; NUNCA produção). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

const d = process.env.CW_TEST_PG_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36);

d("summarizeIntegrity (Postgres real)", () => {
  let prisma: typeof import("@/server/db").prisma;
  let DS = "", other = "", projectId = "", connectionId = "";
  const tableIds: Record<string, string> = {};
  const sourceIds: Record<string, string> = {};

  async function mkDataset(tag: string) {
    return (await prisma.dataset.create({ data: { projectId, name: `led-${tag}`, slug: `led-${tag}-${SUFFIX}`, schemaName: `led_${tag}_${SUFFIX}` } })).id;
  }
  async function mkTable(dataset: string, name: string, src?: { active?: boolean }) {
    const t = await prisma.datasetTable.create({ data: { datasetId: dataset, name, sqlName: name } });
    tableIds[`${dataset}:${name}`] = t.id;
    if (src) {
      const s = await prisma.datasetSource.create({ data: { datasetId: dataset, connectionId, targetTableId: t.id, name, mode: "extract", sourceKind: "table", active: src.active ?? true } });
      sourceIds[`${dataset}:${name}`] = s.id;
    }
    return t.id;
  }
  async function add(dataset: string, table: string, outcome: "COMPLETED" | "FAILED", verdict: string, ageMin: number, o: { detail?: object; mode?: string; sourceId?: string | null; kind?: string } = {}) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_load_ledger (kind, dataset_id, table_name, source_id, mode, outcome, verdict, expected_rows, parsed_rows, detail_json, created_at)
       VALUES ($7, $1::uuid, $2, $8::uuid, $9, $3, $4, 100, 40, $5, now() - ($6 || ' minutes')::interval)`,
      dataset, table, outcome, verdict, o.detail ? JSON.stringify(o.detail) : null, String(ageMin), o.kind ?? "source", o.sourceId ?? null, o.mode ?? "replace");
  }
  const reasons = { reasons: [{ code: "ROWS_BELOW_EXPECTED", blocking: true, message: "Foram lidas 40 linhas, mas a origem tem 100." }] };
  const attention = async (names: string[]) => {
    const { summarizeIntegrity } = await import("./ledger");
    const s = await summarizeIntegrity(24);
    return { s, byName: Object.fromEntries(s.tablesNeedingAttention.filter((t) => t.tableName && names.includes(t.tableName) && [DS, other].length).map((t) => [t.tableName!, t])) };
  };

  beforeAll(async () => {
    ({ prisma } = await import("@/server/db"));
    projectId = (await prisma.project.create({ data: { name: `led-${SUFFIX}`, slug: `led-${SUFFIX}` } })).id;
    connectionId = (await prisma.connection.create({ data: { name: `led-${SUFFIX}`, environment: "test", server: "x", databaseName: "x", username: "x", encryptedCredentials: "x" } })).id;
    DS = await mkDataset("a");
    other = await mkDataset("b");
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM cw_load_ledger WHERE dataset_id IN ($1::uuid, $2::uuid)`, DS, other);
    await prisma.datasetSource.deleteMany({ where: { datasetId: { in: [DS, other] } } });
    await prisma.datasetTable.deleteMany({ where: { datasetId: { in: [DS, other] } } });
    await prisma.dataset.deleteMany({ where: { id: { in: [DS, other] } } });
    await prisma.connection.delete({ where: { id: connectionId } });
    await prisma.project.delete({ where: { id: projectId } });
  });

  it("a última carga de cada tabela decide: falha sem recuperação alerta; falha seguida de OK encerra o alerta", async () => {
    for (const n of ["vendas", "estoque", "cadastro"]) await mkTable(DS, n);
    await mkTable(other, "vendas");
    await add(DS, "vendas", "FAILED", "FAILED", 60, { detail: reasons, kind: "upload" });   // sem recuperação
    await add(DS, "estoque", "FAILED", "FAILED", 90, { detail: reasons, kind: "upload" });
    await add(DS, "estoque", "COMPLETED", "OK", 10, { kind: "upload" });                    // recuperou depois
    await add(DS, "cadastro", "COMPLETED", "SUSPECT", 30, { detail: { reasons: [{ message: "Queda de 500 para 300 linhas." }] }, kind: "upload" });
    await add(other, "vendas", "COMPLETED", "OK", 5, { kind: "upload" });                    // mesmo nome, outro dataset: independente
    const { s, byName } = await attention(["vendas", "estoque", "cadastro"]);
    expect(byName.vendas?.verdict).toBe("FAILED");
    expect(byName.vendas?.reason).toContain("40 linhas");
    expect(byName.cadastro?.verdict).toBe("SUSPECT");
    expect(byName.estoque).toBeUndefined();
    expect(s.loads).toBeGreaterThanOrEqual(5);
    expect(s.failed).toBeGreaterThanOrEqual(2);
  });

  it("M1a: falha transitória (ERROR, ou FAILED só com `error`) NÃO é 'atenção'; barra de integridade é", async () => {
    await mkTable(DS, "rede"); await mkTable(DS, "legado_erro"); await mkTable(DS, "barrada");
    await add(DS, "rede", "FAILED", "ERROR", 20, { detail: { error: "ETIMEDOUT" } });
    await add(DS, "legado_erro", "FAILED", "FAILED", 20, { detail: { error: "timeout" } });   // gravado por caminho antigo (upload/derivada): so `error`
    await add(DS, "barrada", "FAILED", "FAILED", 20, { detail: reasons });
    const { byName } = await attention(["rede", "legado_erro", "barrada"]);
    expect(byName.rede).toBeUndefined();
    expect(byName.legado_erro).toBeUndefined();
    expect(byName.barrada?.verdict).toBe("FAILED");
  });

  it("M1b: tabela apagada (órfã), fonte apagada e fonte pausada saem da lista", async () => {
    await mkTable(DS, "pausada", { active: false });
    await mkTable(DS, "ativa", { active: true });
    await add(DS, "orfa_sem_tabela", "FAILED", "FAILED", 20, { detail: reasons });                             // nem tabela existe
    await add(DS, "pausada", "FAILED", "FAILED", 20, { detail: reasons, sourceId: sourceIds[`${DS}:pausada`] });
    await add(DS, "ativa", "FAILED", "FAILED", 20, { detail: reasons, sourceId: sourceIds[`${DS}:ativa`] });
    await mkTable(DS, "fonte_apagada");
    await add(DS, "fonte_apagada", "FAILED", "FAILED", 20, { detail: reasons, sourceId: crypto.randomUUID() }); // fonte inexistente
    const { byName } = await attention(["orfa_sem_tabela", "pausada", "ativa", "fonte_apagada"]);
    expect(byName.orfa_sem_tabela).toBeUndefined();
    expect(byName.pausada).toBeUndefined();
    expect(byName.fonte_apagada).toBeUndefined();
    expect(byName.ativa?.verdict).toBe("FAILED");
  });

  it("M1c: reconciliação barrada não é mascarada por um incremental OK depois; só reconciliação OK limpa", async () => {
    await mkTable(DS, "mascara");
    await add(DS, "mascara", "FAILED", "FAILED", 60, { detail: reasons, mode: "reconciliation" });
    await add(DS, "mascara", "COMPLETED", "OK", 10, { mode: "incremental" });
    let { byName } = await attention(["mascara"]);
    expect(byName.mascara).toMatchObject({ verdict: "FAILED", mode: "reconciliation" });
    await add(DS, "mascara", "COMPLETED", "OK", 1, { mode: "reconciliation" });
    ({ byName } = await attention(["mascara"]));
    expect(byName.mascara).toBeUndefined();
  });

  it("M1d: purgeLedger apaga em lotes só o que passou da retenção (90 dias)", async () => {
    await mkTable(DS, "velha");
    await add(DS, "velha", "COMPLETED", "OK", 60 * 24 * 100); // 100 dias
    await add(DS, "velha", "COMPLETED", "OK", 60 * 24 * 100);
    await add(DS, "velha", "COMPLETED", "OK", 60 * 24 * 100);
    await add(DS, "velha", "COMPLETED", "OK", 5);
    const { purgeLedger } = await import("./ledger");
    const before = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) n FROM cw_load_ledger WHERE dataset_id = $1::uuid AND table_name = 'velha'`, DS))[0]!.n);
    expect(before).toBe(4);
    const removed = await purgeLedger(90, 2); // lotes de 2: exige mais de uma rodada
    expect(removed).toBeGreaterThanOrEqual(3);
    const after = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) n FROM cw_load_ledger WHERE dataset_id = $1::uuid AND table_name = 'velha'`, DS))[0]!.n);
    expect(after).toBe(1);
  });
});
