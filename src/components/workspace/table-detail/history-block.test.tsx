import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoryBlock } from "./history-block";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = new Date().toISOString();

const history = {
  versions: [
    { id: "v1", createdAt: NOW, rowCount: "1487197", origin: "upload", upload: { id: "u1", filename: "vendas.csv", mode: "replace", createdBy: "ana@x.com", sizeBytes: "2097152", fileAvailable: true } },
    { id: "v2", createdAt: NOW, rowCount: "5", origin: "upload", upload: { id: "u2", filename: "velho.csv", mode: "append", createdBy: null, sizeBytes: "10", fileAvailable: false } },
    { id: "v0", createdAt: NOW, rowCount: "10", origin: "sync", upload: null },
  ],
  runs: [
    { id: "r1", jobId: "j1", kind: "IMPORT_UPLOAD", status: "COMPLETED", startedAt: NOW, durationMs: 65_000, rssMb: 512, error: null },
    { id: "r2", jobId: "j2", kind: "SOURCE_REFRESH", status: "FAILED", startedAt: NOW, durationMs: null, rssMb: null, error: "timeout na origem" },
  ],
  runsNote: "Execuções anteriores a esta versão aparecem sem duração nem memória.",
};

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return json(200, { data: history, meta: null, error: null }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function open() {
  fireEvent.click(screen.getByText("Histórico"));
  // jsdom não dispara "toggle" sozinho ao abrir <details>: dispara manualmente
  const details = document.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("HistoryBlock", () => {
  it("não busca nada até abrir (o painel abre sem custo)", () => {
    render(<HistoryBlock tableId="t1" />);
    expect(calls).toHaveLength(0);
  });
  it("ao abrir, busca uma vez e mostra versões com linhas exatas e origem", async () => {
    render(<HistoryBlock tableId="t1" />);
    open();
    expect(await screen.findByText("1.487.197 linhas")).toBeInTheDocument();
    expect(screen.getByText("vendas.csv")).toBeInTheDocument();
    expect(screen.getByText(/por ana@x\.com/)).toBeInTheDocument();
    expect(screen.getByText("Sincronização da fonte")).toBeInTheDocument();
    expect(calls).toEqual(["/api/v1/tables/t1/history"]);
    open(); // reabrir não busca de novo
    expect(calls).toHaveLength(1);
  });
  it("execuções: tipo em português, duração, memória, falha com a mensagem, e a nota de dados antigos", async () => {
    render(<HistoryBlock tableId="t1" />);
    open();
    expect(await screen.findByText("Importação de upload")).toBeInTheDocument();
    expect(screen.getByText(/levou 1m 5s/)).toBeInTheDocument();
    expect(screen.getByText(/512 MB de memória/)).toBeInTheDocument();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.getByText("timeout na origem")).toBeInTheDocument();
    expect(screen.getByText(/anteriores a esta versão/)).toBeInTheDocument();
  });
  it("erro da API aparece em português num alerta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { data: null, meta: null, error: { code: "FORBIDDEN", message: "x" } })));
    render(<HistoryBlock tableId="t1" />);
    open();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/permissão/i));
  });
  it("listas vazias explicam, em vez de ficar em branco", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: { versions: [], runs: [], runsNote: null }, meta: null, error: null })));
    render(<HistoryBlock tableId="t1" />);
    open();
    expect(await screen.findByText("Nenhuma versão registrada ainda.")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma execução registrada para esta tabela.")).toBeInTheDocument();
  });

  it("versão com arquivo guardado oferece o download; sem arquivo explica que a retenção o removeu", async () => {
    render(<HistoryBlock tableId="t1" />);
    open();
    const link = await screen.findByRole("link", { name: /Baixar arquivo original/ });
    expect(link.getAttribute("href")).toBe("/api/v1/tables/t1/versions/v1/file");
    expect(link.textContent).toContain("2");
    expect(screen.getAllByRole("link", { name: /Baixar arquivo original/ })).toHaveLength(1);
    expect(screen.getByText(/Arquivo original não guardado/)).toBeInTheDocument();
  });
});
