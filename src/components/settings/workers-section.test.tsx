import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkersSection } from "./workers-section";

const profile = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", name: "worker-uploads", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], concurrency: 1, pollMs: 2000,
  duckdbMemoryLimit: "1GB", enabled: true, runningJobs: 2, queuedJobs: 5,
  runtime: { state: "RUNNING", pid: 4242, restarts: 1, lastExitCode: null, restartPending: false }, ...over,
});

let supervised = true;
let profiles = [profile()];
let meta: Record<string, unknown> | null = null;
let posted: { url: string; body: unknown }[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  supervised = true;
  profiles = [profile()];
  meta = null;
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return json(201, { data: { id: "c1" }, meta: null, error: null });
    }
    return json(200, { data: { supervisor: { supervised, hostname: "h1", pid: 10, heartbeatAt: new Date().toISOString() }, profiles, commands: [] }, meta, error: null });
  }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Workers (Configurações)", () => {
  it("lista o perfil com estado, tipos em português e jobs rodando/na fila", async () => {
    render(<WorkersSection />);
    expect(await screen.findByText("worker-uploads")).toBeTruthy();
    expect(screen.getByText("Rodando")).toBeTruthy();
    expect(screen.getByText(/Prévia de upload, Importação de upload/)).toBeTruthy();
    expect(screen.getByText("2 / 5")).toBeTruthy();
    expect(screen.getByText(/Supervisor ativo em h1/)).toBeTruthy();
  });

  it("sem supervisor: avisa, mostra 'Sem supervisor' e desabilita reiniciar/parar (editar continua)", async () => {
    supervised = false;
    profiles = [profile({ runtime: null })];
    render(<WorkersSection />);
    expect(await screen.findByText(/Nenhum supervisor está ativo/)).toBeTruthy();
    expect(screen.getByText("Sem supervisor")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reiniciar worker-uploads" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Parar worker-uploads" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Editar worker-uploads" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("mostra 'reinício pendente' e os avisos da API (tipo de job sem worker)", async () => {
    profiles = [profile({ runtime: { state: "RUNNING", pid: 1, restarts: 0, lastExitCode: null, restartPending: true } })];
    meta = { warnings: ["Nenhum perfil habilitado processa: SOURCE_REFRESH. Esses jobs ficarão na fila."] };
    render(<WorkersSection />);
    expect(await screen.findByText(/Reinício pendente/)).toBeTruthy();
    expect(screen.getByText(/Nenhum perfil habilitado processa: SOURCE_REFRESH/)).toBeTruthy();
  });

  it("perfil desabilitado aparece como Desabilitado e o botão vira Iniciar", async () => {
    profiles = [profile({ enabled: false })];
    render(<WorkersSection />);
    expect(await screen.findByText("Desabilitado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Iniciar worker-uploads" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reiniciar worker-uploads" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Reiniciar abre o diálogo e, com segurança (padrão), envia o comando SAFE para o perfil", async () => {
    render(<WorkersSection />);
    await screen.findByText("worker-uploads");
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar worker-uploads" }));
    expect(await screen.findByText("Como reiniciar o worker \"worker-uploads\"?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar com segurança" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: "/api/v1/system/commands",
      body: { action: "RESTART_PROFILE", mode: "SAFE", profileId: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("Reiniciar agora: escolher o modo destrutivo envia IMMEDIATE; cancelar não envia nada", async () => {
    render(<WorkersSection />);
    await screen.findByText("worker-uploads");
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar worker-uploads" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar worker-uploads" }));
    fireEvent.click(await screen.findByLabelText(/^Agora/));
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar agora" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]!.body as { mode: string }).mode).toBe("IMMEDIATE");
  });

  it("Reiniciar todos usa RESTART_ALL sem perfil", async () => {
    render(<WorkersSection />);
    await screen.findByText("worker-uploads");
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar todos os workers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reiniciar com segurança" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ action: "RESTART_ALL", mode: "SAFE" });
  });
});
