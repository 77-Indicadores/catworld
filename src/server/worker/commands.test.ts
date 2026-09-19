import { describe, expect, it } from "vitest";
import { COMMAND_STATUSES, canTransition, commandCreateSchema, commandsConflict, isOpen } from "./commands";

const P = "11111111-1111-4111-8111-111111111111";

describe("máquina de estados dos comandos", () => {
  it("caminho feliz: PENDING → ACCEPTED → DRAINING → DONE (e FORCED no prazo)", () => {
    expect(canTransition("PENDING", "ACCEPTED")).toBe(true);
    expect(canTransition("ACCEPTED", "DRAINING")).toBe(true);
    expect(canTransition("DRAINING", "DONE")).toBe(true);
    expect(canTransition("DRAINING", "FORCED")).toBe(true);
  });
  it("cancelar só antes de aceito; expirar só pendente", () => {
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    for (const s of ["ACCEPTED", "DRAINING", "APPLYING"] as const) expect(canTransition(s, "CANCELLED")).toBe(false);
    expect(canTransition("PENDING", "EXPIRED")).toBe(true);
    expect(canTransition("DRAINING", "EXPIRED")).toBe(false);
  });
  it("estados finais não mudam mais e nada volta atrás", () => {
    for (const t of ["DONE", "FORCED", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      for (const to of COMMAND_STATUSES) expect(canTransition(t, to), `${t}->${to}`).toBe(false);
      expect(isOpen(t)).toBe(false);
    }
    expect(canTransition("DRAINING", "PENDING")).toBe(false);
    expect(canTransition("DONE", "DRAINING")).toBe(false);
  });
  it("abertos são exatamente os que ainda andam", () => {
    expect(COMMAND_STATUSES.filter(isOpen)).toEqual(["PENDING", "ACCEPTED", "DRAINING", "APPLYING"]);
  });
});

describe("commandCreateSchema", () => {
  it("padrões: modo SEGURO e prazo de 10 min", () => {
    expect(commandCreateSchema.parse({ action: "RESTART_PROFILE", profileId: P })).toMatchObject({ mode: "SAFE", timeoutMs: 600000 });
  });
  it("ações por perfil exigem profileId; as globais não aceitam", () => {
    expect(commandCreateSchema.safeParse({ action: "RESTART_PROFILE" }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "STOP_PROFILE", profileId: "x" }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "RESTART_ALL", profileId: P }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "RESTART_ALL" }).success).toBe(true);
    expect(commandCreateSchema.safeParse({ action: "RESTART_SUPERVISOR", mode: "IMMEDIATE" }).success).toBe(true);
  });
  it("só ações da lista; iniciar não tem modo imediato; prazo limitado", () => {
    expect(commandCreateSchema.safeParse({ action: "RM_RF" }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "START_PROFILE", profileId: P, mode: "IMMEDIATE" }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "RESTART_ALL", timeoutMs: 999 }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "RESTART_ALL", timeoutMs: 3_600_001 }).success).toBe(false);
    expect(commandCreateSchema.safeParse({ action: "RESTART_ALL", mode: "AGORA" }).success).toBe(false);
  });
});

describe("commandsConflict", () => {
  it("mesmo perfil conflita; perfis diferentes não; comando global conflita com tudo", () => {
    const a = { action: "RESTART_PROFILE" as const, profileId: "p1" };
    expect(commandsConflict(a, { action: "STOP_PROFILE", profileId: "p1" })).toBe(true);
    expect(commandsConflict(a, { action: "RESTART_PROFILE", profileId: "p2" })).toBe(false);
    expect(commandsConflict(a, { action: "RESTART_ALL", profileId: null })).toBe(true);
    expect(commandsConflict({ action: "RESTART_SUPERVISOR", profileId: null }, { action: "START_PROFILE", profileId: "p9" })).toBe(true);
  });
});
