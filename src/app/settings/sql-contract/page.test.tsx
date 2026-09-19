import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SqlContractSettingsPage from "./page";

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return respond({ data: { mode: JSON.parse(String(init.body)).mode }, error: null });
    return respond({ data: { mode: "fallback", modes: ["off", "shadow", "fallback", "strict"] }, error: null });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("tela Contrato de SQL", () => {
  it("carrega o modo atual e mostra as tres opcoes", async () => {
    render(<SqlContractSettingsPage />);
    expect(await screen.findByText("Fallback (padrão)")).toBeTruthy();
    expect(screen.getByText("Observar")).toBeTruthy();
    expect(screen.getByText("Desligado")).toBeTruthy();
    expect(screen.getByText("Estrito")).toBeTruthy();
    // modo atual = fallback: nada a salvar ainda
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("estrito mostra o aviso e salva via PATCH", async () => {
    render(<SqlContractSettingsPage />);
    fireEvent.click(await screen.findByText("Estrito"));
    expect(screen.getByText(/pode rejeitar consultas que hoje funcionam/)).toBeTruthy();

    const save = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText(/Modo salvo/)).toBeTruthy());
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/v1/settings/sql-contract");
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ mode: "strict" });
    // apos salvar, o aviso some e o botao volta a desabilitado
    expect(screen.queryByText(/pode rejeitar consultas/)).toBeNull();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("mostra o erro da API quando falha ao salvar", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? respond({ data: null, error: { message: "Sem permissão" } })
        : respond({ data: { mode: "fallback", modes: [] }, error: null }),
    );
    render(<SqlContractSettingsPage />);
    fireEvent.click(await screen.findByText("Desligado"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Sem permissão")).toBeTruthy();
  });

  it("erro ao carregar exibe a mensagem em vez de travar no spinner", async () => {
    fetchMock.mockImplementation(() => respond({ data: null, error: { message: "Acesso negado" } }));
    render(<SqlContractSettingsPage />);
    expect(await screen.findByText("Acesso negado")).toBeTruthy();
  });
});
