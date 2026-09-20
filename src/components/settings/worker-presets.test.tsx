import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkerPresets } from "./worker-presets";

const SYNC_ID = "11111111-1111-4111-8111-111111111111";
const LONG_ID = "33333333-3333-4333-8333-333333333333";
const HEAVY_ID = "44444444-4444-4444-8444-444444444444";
const UP_ID = "22222222-2222-4222-8222-222222222222";

let supervised = true;
let lanes = false;               // false = estado legado (2 perfis, sem faixas); true = 4 faixas
let slots = { sync: 1, long: 1, up: 1, heavy: 1 };
let settings = { max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 200, memory_limit_gb: 0 };
let posts: { url: string; body: Record<string, unknown> }[] = [];
let presetResponseMeta: Record<string, unknown> = { restartProfiles: ["worker-sync", "worker-uploads"] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  supervised = true; lanes = false; slots = { sync: 1, long: 1, up: 1, heavy: 1 }; posts = [];
  settings = { max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 200, memory_limit_gb: 0 };
  presetResponseMeta = { restartProfiles: ["worker-sync", "worker-uploads"] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/settings/worker/preset")) return json(200, { data: { preset: "equilibrado", changes: [] }, meta: presetResponseMeta, error: null });
      return json(201, { data: { id: "c1" }, meta: null, error: null });
    }
    if (url.endsWith("/api/v1/workers")) {
      return json(200, {
        data: {
          supervisor: { supervised },
          profiles: lanes ? [
            { id: SYNC_ID, name: "worker-sync", jobTypes: ["SOURCE_REFRESH", "METADATA_CLEANUP"], weights: [0, 1], concurrency: slots.sync, enabled: true, runningJobs: 1, queuedJobs: 49 },
            { id: LONG_ID, name: "worker-sync-long", jobTypes: ["SOURCE_REFRESH", "DERIVED_REFRESH"], weights: [2], concurrency: slots.long, enabled: true, runningJobs: 0, queuedJobs: 2 },
            { id: UP_ID, name: "worker-uploads", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], weights: [0, 1], concurrency: slots.up, enabled: true, runningJobs: 1, queuedJobs: 21 },
            { id: HEAVY_ID, name: "worker-uploads-heavy", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], weights: [2], concurrency: slots.heavy, enabled: true, runningJobs: 0, queuedJobs: 3 },
          ] : [
            { id: SYNC_ID, name: "worker-sync", jobTypes: ["SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP"], weights: [], concurrency: slots.sync, enabled: true, runningJobs: 1, queuedJobs: 49 },
            { id: UP_ID, name: "worker-uploads", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], weights: [], concurrency: slots.up, enabled: true, runningJobs: 1, queuedJobs: 21 },
          ],
        }, meta: null, error: null,
      });
    }
    return json(200, { data: settings, meta: null, error: null });
  }));
  vi.stubGlobal("alert", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WorkerPresets", () => {
  it("mostra o que roda na prática, marca 'personalizado' e a capacidade agora (rodando/slots e fila)", async () => {
    render(<WorkerPresets />);
    expect(await screen.findByText(/configuração/i)).toBeTruthy();
    expect(screen.getByText(/configuração/i).textContent).toContain("personalizada");
    const syncCard = screen.getByText("Sync rápido").closest("div.rounded-lg")!;
    expect(syncCard.textContent).toContain("rodando 1 / 1");
    expect(syncCard.textContent).toContain("na fila 49");
    expect(screen.getByText("Uploads leves").closest("div.rounded-lg")!.textContent).toContain("na fila 21");
    // faixas que ainda não existem aparecem como tal (nada de "perfil não encontrado")
    expect(screen.getByText("Sync longo").closest("div.rounded-lg")!.textContent).toContain("ainda não criada");
    // o card Personalizado está em uso
    const custom = screen.getByRole("button", { name: /Personalizado/ });
    expect(custom.textContent).toContain("em uso");
  });

  it("detecta o perfil em uso quando os valores batem com um preset", async () => {
    lanes = true; slots = { sync: 3, long: 1, up: 2, heavy: 1 }; settings = { max_heavy_jobs: 2, max_syncs_per_storage: 2, import_batch_delay_ms: 150, memory_limit_gb: 0 };
    render(<WorkerPresets />);
    const eq = await screen.findByRole("button", { name: /Equilibrado/ });
    expect(eq.textContent).toContain("em uso");
    expect(screen.getByText(/perfil/).textContent).toContain("Equilibrado");
  });

  it("escolher um perfil mostra o que muda (hoje -> novo, e quando vale) e o efeito esperado", async () => {
    render(<WorkerPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /Equilibrado/ }));
    expect(screen.getByText(/O que muda ao aplicar/)).toBeTruthy();
    expect(screen.getByText(/Faixas de worker/).closest("tr")!.textContent).toContain("ligadas");
    const row = screen.getByText("Sync rápido", { selector: "td" }).closest("tr")!;
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("após reiniciar");
    expect(screen.getByText("Sync longo", { selector: "td" }).closest("tr")!.textContent).toContain("sobe sozinho");
    expect(screen.getByText("Teto de jobs pesados").closest("tr")!.textContent).toContain("em até 10 s");
    expect(screen.getByText(/No máximo/).textContent).toContain("7");
    expect(screen.getByText(/limite do container não informado/)).toBeTruthy();
  });

  it("'Salvar e reiniciar com segurança' aplica o preset e pede reinício SEGURO de cada perfil que mudou", async () => {
    const onApplied = vi.fn();
    render(<WorkerPresets onApplied={onApplied} />);
    fireEvent.click(await screen.findByRole("button", { name: /Equilibrado/ }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar e reiniciar com segurança/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(posts[0]).toEqual({ url: "/api/v1/settings/worker/preset", body: { preset: "equilibrado" } });
    const restarts = posts.filter((p) => p.url === "/api/v1/system/commands").map((p) => p.body);
    expect(restarts).toEqual([
      { action: "RESTART_PROFILE", mode: "SAFE", profileId: SYNC_ID },
      { action: "RESTART_PROFILE", mode: "SAFE", profileId: UP_ID },
    ]);
  });

  it("'Só salvar' aplica o preset e NÃO reinicia nada", async () => {
    render(<WorkerPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /Alto desempenho/ }));
    fireEvent.click(screen.getByRole("button", { name: "Só salvar" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.url).toBe("/api/v1/settings/worker/preset");
    expect((window.alert as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toContain("Reinicie os workers");
  });

  it("sem supervisor: só dá para salvar (reiniciar fica desabilitado)", async () => {
    supervised = false;
    render(<WorkerPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /Equilibrado/ }));
    expect((screen.getByRole("button", { name: /Salvar e reiniciar com segurança/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Só salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("avisa quando a memória de pico estimada passa do limite informado", async () => {
    settings = { ...settings, memory_limit_gb: 4 };
    render(<WorkerPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /Alto desempenho/ }));
    expect(screen.getByText(/Memória de pico estimada/)).toBeTruthy();
  });

  it("clicar no perfil em uso, ou em Cancelar, fecha o painel sem alterar nada", async () => {
    lanes = true; slots = { sync: 3, long: 1, up: 2, heavy: 1 }; settings = { max_heavy_jobs: 2, max_syncs_per_storage: 2, import_batch_delay_ms: 150, memory_limit_gb: 0 };
    render(<WorkerPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /Alto desempenho/ }));
    expect(screen.getByText(/O que muda ao aplicar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/O que muda ao aplicar/)).toBeNull();
    expect(posts).toEqual([]);
  });

  it("o card Personalizado abre a seção de ajuste fino", async () => {
    const onCustomize = vi.fn();
    render(<WorkerPresets onCustomize={onCustomize} />);
    fireEvent.click(await screen.findByRole("button", { name: /Personalizado/ }));
    expect(onCustomize).toHaveBeenCalled();
  });
});
