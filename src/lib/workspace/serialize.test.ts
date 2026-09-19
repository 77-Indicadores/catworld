import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { serializeWorkspaceProject, type WorkspaceProjectRow } from "./serialize";

const D = new Date("2026-09-19T17:32:05.123Z");

function row(over: { rowCount?: bigint; lastRowCount?: bigint | null; source?: boolean } = {}): WorkspaceProjectRow {
  const source = over.source === false ? null : {
    id: "s1", datasetId: "d1", connectionId: "c1", targetTableId: "t1", name: "vendas", mode: "extract", sourceKind: "table",
    sourceGroupId: null, sourceSchema: "dbo", sourceTable: "vendas", sourceSql: null, refreshCron: "0 * * * *", keyColumn: "id",
    deltaColumn: "atualizado_em", lastDeltaValue: null, reconciliationCron: null, sourceSqlReconciliation: null, lastStatus: "completed",
    lastRowCount: over.lastRowCount === undefined ? 42n : over.lastRowCount, lastError: null, active: true, lastRefreshedAt: D, nextRefreshAt: null,
    lastReconciliationAt: null, nextReconciliationAt: null, createdAt: D, updatedAt: D,
    connection: { id: "c1", name: "dev-live", provider: "postgres" },
  };
  return {
    id: "p1", slug: "teste", name: "Teste", description: null, active: true, createdAt: D, updatedAt: D,
    datasets: [{
      id: "d1", projectId: "p1", slug: "ds", name: "DS", description: "d", active: true, schemaName: "ds_test", storageServerId: null, createdAt: D, updatedAt: D,
      storageServer: null,
      tables: [{
        id: "t1", datasetId: "d1", name: "vendas", sqlName: "vendas", rowCount: over.rowCount ?? 1487197n, sizeBytes: 9007199254740993n, lastDataAt: D, createdAt: D, updatedAt: D,
        columns: [{ id: "col1", tableId: "t1", ordinal: 1, originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false }],
        source,
      }],
      derivedTables: [{
        id: "dv1", datasetId: "d1", targetTableId: "t1", name: "resumo", sqlName: "resumo", querySql: "SELECT 1", refreshCron: null, nextRefreshAt: null, active: true,
        lastStatus: "ok", lastRowCount: null, lastError: null, lastRefreshedAt: null, createdAt: D, updatedAt: D,
        targetTable: { id: "t2", rowCount: 5n, lastDataAt: null },
      }],
    }],
  } as unknown as WorkspaceProjectRow;
}

describe("serializeWorkspaceProject", () => {
  it("BigInt vira string EXATA (inclusive acima de 2^53) e Date vira ISO", () => {
    const p = serializeWorkspaceProject(row());
    const t = p.datasets[0]!.tables[0]!;
    expect(t.rowCount).toBe("1487197");
    expect(t.sizeBytes).toBe("9007199254740993");
    expect(t.lastDataAt).toBe("2026-09-19T17:32:05.123Z");
    expect(t.source!.lastRowCount).toBe("42");
    expect(t.source!.lastRefreshedAt).toBe("2026-09-19T17:32:05.123Z");
    expect(t.source!.nextRefreshAt).toBeNull();
  });
  it("carrega schema do dataset, nome SQL, chave/delta e conexão (o que a tela precisa para 'origem' e 'uso')", () => {
    const d = serializeWorkspaceProject(row()).datasets[0]!;
    expect(d.schemaName).toBe("ds_test");
    const s = d.tables[0]!.source!;
    expect(s).toMatchObject({ keyColumn: "id", deltaColumn: "atualizado_em", connection: { id: "c1", name: "dev-live" }, sourceSchema: "dbo", sourceTable: "vendas" });
  });
  it("tabela sem fonte (upload) e sem upload conhecido: source e lastUpload nulos", () => {
    const t = serializeWorkspaceProject(row({ source: false })).datasets[0]!.tables[0]!;
    expect(t.source).toBeNull();
    expect(t.lastUpload).toBeNull();
  });
  it("junta o último upload da tabela quando informado", () => {
    const up = { id: "u1", filename: "vendas.csv", mode: "replace", sizeBytes: "1048576", createdAt: D.toISOString(), createdBy: null };
    const t = serializeWorkspaceProject(row({ source: false }), new Map([["t1", up]])).datasets[0]!.tables[0]!;
    expect(t.lastUpload).toEqual(up);
  });
  it("lastRowCount nulo continua nulo (não vira 'null' nem 0); derivada mantém o destino", () => {
    const p = serializeWorkspaceProject(row({ lastRowCount: null }));
    expect(p.datasets[0]!.tables[0]!.source!.lastRowCount).toBeNull();
    expect(p.datasets[0]!.derivedTables[0]).toMatchObject({ lastRowCount: null, targetTable: { id: "t2", rowCount: "5", lastDataAt: null } });
  });
  it("o payload é serializável em JSON (sem BigInt/Date crus)", () => {
    expect(() => JSON.stringify(serializeWorkspaceProject(row()))).not.toThrow();
  });
});
