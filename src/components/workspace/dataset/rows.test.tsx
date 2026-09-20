import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceSource, WorkspaceTable } from "@/lib/workspace/types";
import { BatchGroupRow } from "./batch-group-row";
import { SingleSourceRow } from "./single-source-row";

const NOW_ISO = new Date().toISOString();

const source = (over: Partial<WorkspaceSource> = {}): WorkspaceSource => ({
  id: "s1", name: "vendas", mode: "extract", sourceKind: "table", sourceGroupId: null, sourceSchema: "dbo", sourceTable: "vendas", sourceSql: null,
  refreshCron: "0 * * * *", keyColumn: "id", deltaColumn: null, reconciliationCron: null, sourceSqlReconciliation: null, scopeColumns: null, keysCheckCron: null, keysSql: null, nextKeysCheckAt: null, lastKeysCheckAt: null, lastRemovedCount: null, active: true,
  lastStatus: "completed", lastRowCount: "1487197", lastError: null, lastRefreshedAt: NOW_ISO, nextRefreshAt: new Date(Date.now() + 3600_000).toISOString(),
  connection: { id: "c1", name: "dev-live" }, ...over,
});

const table = (s: WorkspaceSource, name = s.name): WorkspaceTable => ({
  id: `t-${s.id}`, name, sqlName: name, rowCount: "10", sizeBytes: "1", lastDataAt: NOW_ISO, source: s, columns: [], lastUpload: null,
});

beforeEach(() => { vi.stubGlobal("confirm", vi.fn(() => true)); vi.stubGlobal("alert", vi.fn()); HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SingleSourceRow: origem da fonte", () => {
  const noop = () => undefined;
  it("fonte de TABELA mostra schema.tabela, não 'Consulta personalizada' (bug antigo)", () => {
    const s = source();
    render(<SingleSourceRow source={s} table={table(s)} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText(/dev-live · dbo\.vendas/)).toBeInTheDocument();
    expect(screen.queryByText(/Consulta personalizada/)).toBeNull();
  });
  it("fonte de SQL mostra 'Consulta personalizada'", () => {
    const s = source({ sourceKind: "query", sourceTable: null, sourceSchema: null, sourceSql: "SELECT 1" });
    render(<SingleSourceRow source={s} table={table(s)} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getAllByText(/dev-live · Consulta personalizada/).length).toBeGreaterThan(0);
  });
  it("mostra a contagem EXATA e quando foi atualizada", () => {
    const s = source();
    render(<SingleSourceRow source={s} table={table(s)} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText(/1\.487\.197 linhas/)).toBeInTheDocument();
    expect(screen.getByText(/atualizada/)).toBeInTheDocument();
  });
  it("badge em português único: Em dia, Com erro e Atrasada", () => {
    const { unmount } = render(<SingleSourceRow source={source()} table={table(source())} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText("Em dia")).toBeInTheDocument();
    unmount();
    const failed = source({ lastStatus: "failed", lastError: "timeout" });
    const r2 = render(<SingleSourceRow source={failed} table={table(failed)} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText("Com erro")).toBeInTheDocument();
    r2.unmount();
    const late = source({ nextRefreshAt: new Date(Date.now() - 3 * 3600_000).toISOString(), lastRefreshedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });
    render(<SingleSourceRow source={late} table={table(late)} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText("Atrasada")).toBeInTheDocument();
  });
});

describe("BatchGroupRow: várias tabelas de uma importação", () => {
  const noop = () => undefined;
  it("lista TODAS as tabelas com erro, cada uma com sua mensagem (antes só a primeira)", () => {
    const a = source({ id: "a", name: "clientes", sourceTable: "clientes", sourceGroupId: "g", lastStatus: "failed", lastError: "permissão negada" });
    const b = source({ id: "b", name: "pedidos", sourceTable: "pedidos", sourceGroupId: "g", lastStatus: "failed", lastError: "timeout" });
    const c = source({ id: "c", name: "itens", sourceTable: "itens", sourceGroupId: "g" });
    render(<BatchGroupRow groupId="g" datasetId="d1" sources={[a, b, c]} tables={[table(a), table(b), table(c)]} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText("clientes: permissão negada")).toBeInTheDocument();
    expect(screen.getByText("pedidos: timeout")).toBeInTheDocument();
    expect(screen.getByText("2 tabelas com erro")).toBeInTheDocument();
    expect(screen.getAllByText("Com erro").length).toBeGreaterThan(0);
  });
  it("mostra a última sincronização do grupo", () => {
    const a = source({ id: "a", sourceGroupId: "g" });
    render(<BatchGroupRow groupId="g" datasetId="d1" sources={[a]} tables={[table(a)]} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getByText(/última/)).toBeInTheDocument();
  });
  it("grupo pausado = 'Pausada', sem julgar erro", () => {
    const a = source({ id: "a", sourceGroupId: "g", active: false, lastStatus: "failed", lastError: "x" });
    render(<BatchGroupRow groupId="g" datasetId="d1" sources={[a]} tables={[table(a)]} onSelectTable={noop} onChanged={noop} />);
    expect(screen.getAllByText("Pausada").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
