import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceDataset, WorkspaceDerived, WorkspaceSource, WorkspaceTable, WorkspaceUpload } from "@/lib/workspace/types";
import { FreshnessBlock } from "./freshness-block";
import { OriginBlock } from "./origin-block";
import { UsageBlock } from "./usage-block";

const NOW = new Date().toISOString();
const HOUR_AHEAD = new Date(Date.now() + 3600_000).toISOString();

const source = (over: Partial<WorkspaceSource> = {}): WorkspaceSource => ({
  id: "s1", name: "vendas", mode: "extract", sourceKind: "table", sourceGroupId: null, sourceSchema: "dbo", sourceTable: "vendas", sourceSql: null,
  refreshCron: "0 * * * *", keyColumn: "id", deltaColumn: "atualizado_em", reconciliationCron: null, sourceSqlReconciliation: null, active: true,
  lastStatus: "completed", lastRowCount: "1487197", lastError: null, lastRefreshedAt: NOW, nextRefreshAt: HOUR_AHEAD,
  connection: { id: "c1", name: "dev-live" }, ...over,
});
const upload: WorkspaceUpload = { id: "u1", filename: "vendas_2026.csv", mode: "replace", sizeBytes: "52428800", createdAt: NOW, createdBy: "ana@empresa.com" };
const table = (over: Partial<WorkspaceTable> = {}): WorkspaceTable => ({
  id: "11111111-1111-4111-8111-111111111111", name: "vendas", sqlName: "vendas", rowCount: "1487197", sizeBytes: "52428800", lastDataAt: NOW,
  source: null, columns: [], lastUpload: upload, ...over,
});
const dataset: WorkspaceDataset = { id: "d1", slug: "ds", name: "DS", description: null, active: true, schemaName: "ds_test", storageServerId: null, storageServer: null, tables: [], derivedTables: [] };
const derived: WorkspaceDerived = { id: "dv1", name: "resumo", sqlName: "resumo", querySql: "SELECT 1 AS x", refreshCron: null, active: true, lastStatus: "ok", lastRowCount: null, lastError: null, lastRefreshedAt: NOW, nextRefreshAt: null, targetTable: null };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FreshnessBlock", () => {
  it("mostra a contagem EXATA (não 1.5M), data e hora e o estado em português", () => {
    render(<FreshnessBlock table={table({ source: source() })} derived={null} />);
    expect(screen.getByText("1.487.197")).toBeInTheDocument();
    expect(screen.getByText("Em dia")).toBeInTheDocument();
    expect(screen.getByText("Dados atualizados")).toBeInTheDocument();
    expect(screen.getByText("Última sincronização")).toBeInTheDocument();
    expect(screen.getByText("Próxima")).toBeInTheDocument();
    expect(screen.getByText("50.0 MB")).toBeInTheDocument();
  });
  it("tabela só de upload: neutra 'Atualizada há…', sem julgar atraso e sem 'Próxima'", () => {
    render(<FreshnessBlock table={table()} derived={null} />);
    expect(screen.getByText(/^Atualizada /)).toBeInTheDocument();
    expect(screen.queryByText("Próxima")).toBeNull();
    expect(screen.queryByText("Atrasada")).toBeNull();
  });
  it("erro da fonte aparece num alerta com a mensagem", () => {
    render(<FreshnessBlock table={table({ source: source({ lastStatus: "failed", lastError: "permissão negada" }) })} derived={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("permissão negada");
    expect(screen.getByText("Com erro")).toBeInTheDocument();
  });
  it("fonte atrasada explica quando deveria ter atualizado", () => {
    const s = source({ nextRefreshAt: new Date(Date.now() - 3 * 3600_000).toISOString(), lastRefreshedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });
    render(<FreshnessBlock table={table({ source: s })} derived={null} />);
    expect(screen.getByText("Atrasada")).toBeInTheDocument();
    expect(screen.getByText(/Deveria ter atualizado em/)).toBeInTheDocument();
  });
  it("derivada usa o estado da própria derivada", () => {
    render(<FreshnessBlock table={table({ lastUpload: null })} derived={derived} />);
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });
});

describe("OriginBlock", () => {
  it("upload: arquivo, como entrou, tamanho e quem enviou", () => {
    render(<OriginBlock table={table()} datasetName="DS" derived={null} />);
    expect(screen.getByText("vendas_2026.csv")).toBeInTheDocument();
    expect(screen.getByText("Substituiu os dados")).toBeInTheDocument();
    expect(screen.getByText("50.0 MB")).toBeInTheDocument();
    expect(screen.getByText("ana@empresa.com")).toBeInTheDocument();
  });
  it("upload sem 'quem enviou' (envio antigo) não inventa autor", () => {
    render(<OriginBlock table={table({ lastUpload: { ...upload, createdBy: null } })} datasetName="DS" derived={null} />);
    expect(screen.queryByText("Enviado por")).toBeNull();
  });
  it("fonte extract de tabela: conexão, schema.tabela, agenda em UTC, chave e coluna de mudança", () => {
    render(<OriginBlock table={table({ source: source(), lastUpload: null })} datasetName="DS" derived={null} />);
    expect(screen.getByText("dev-live")).toBeInTheDocument();
    expect(screen.getByText("dbo.vendas")).toBeInTheDocument();
    expect(screen.getByText("0 * * * *")).toBeInTheDocument();
    expect(screen.getByText("(UTC)")).toBeInTheDocument();
    expect(screen.getByText("atualizado_em")).toBeInTheDocument();
  });
  it("fonte por consulta mostra 'Consulta personalizada' e o SQL recolhível", () => {
    const s = source({ sourceKind: "query", sourceTable: null, sourceSchema: null, sourceSql: "SELECT * FROM t" });
    render(<OriginBlock table={table({ source: s, lastUpload: null })} datasetName="DS" derived={null} />);
    expect(screen.getByText("Consulta personalizada")).toBeInTheDocument();
    expect(screen.getByText("SQL da fonte")).toBeInTheDocument();
  });
  it("fonte live não mostra agenda/chave e explica que não copia os dados", () => {
    render(<OriginBlock table={table({ source: source({ mode: "live", refreshCron: null }), lastUpload: null })} datasetName="DS" derived={null} />);
    expect(screen.getByText(/não copia os dados/)).toBeInTheDocument();
    expect(screen.queryByText("Chave")).toBeNull();
  });
  it("derivada mostra o SQL", () => {
    render(<OriginBlock table={table({ lastUpload: null })} datasetName="DS" derived={derived} />);
    expect(screen.getByText("Tabela derivada (SQL)")).toBeInTheDocument();
    expect(screen.getByText("SELECT 1 AS x")).toBeInTheDocument();
  });
});

describe("UsageBlock", () => {
  it("nome SQL com schema, URL OData por tabela e exemplo de consulta", () => {
    render(<UsageBlock table={table()} dataset={dataset} projectSlug="teste" publicOrigin="https://catworld.exemplo.com/" />);
    expect(screen.getByText("ds_test.vendas")).toBeInTheDocument();
    expect(screen.getByText("https://catworld.exemplo.com/api/odata/teste/ds/vendas")).toBeInTheDocument();
    expect(screen.getByText("SELECT TOP 100 * FROM ds_test.vendas")).toBeInTheDocument();
  });
  it("extract: mostra o protocolo incremental (curl e SDK) com o id da tabela", () => {
    render(<UsageBlock table={table({ source: source() })} dataset={dataset} projectSlug="teste" publicOrigin="https://x.com" />);
    expect(screen.getByText(/nextSince/, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/since=<meta\.nextSince>/)).toBeInTheDocument();
    expect(screen.getByText(/client\.changes\("11111111/)).toBeInTheDocument();
  });
  it("live e upload explicam por que não há leitura incremental", () => {
    const { unmount } = render(<UsageBlock table={table({ source: source({ mode: "live" }) })} dataset={dataset} projectSlug="p" publicOrigin="https://x.com" />);
    expect(screen.getByText(/consulta ao vivo/)).toBeInTheDocument();
    unmount();
    render(<UsageBlock table={table()} dataset={dataset} projectSlug="p" publicOrigin="https://x.com" />);
    expect(screen.getByText(/Só tabelas copiadas de uma conexão/)).toBeInTheDocument();
  });
  it("origem pública ausente vira marcador visível", () => {
    render(<UsageBlock table={table()} dataset={dataset} projectSlug="p" publicOrigin="" />);
    expect(screen.getByText(/https:\/\/SEU-CATWORLD\/api\/odata\/p\/ds\/vendas/)).toBeInTheDocument();
  });
  it("copiar coloca o valor na área de transferência e confirma", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<UsageBlock table={table()} dataset={dataset} projectSlug="p" publicOrigin="https://x.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar Nome SQL (T-SQL)" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ds_test.vendas"));
    expect(await screen.findByText("Copiado")).toBeInTheDocument();
  });
});
