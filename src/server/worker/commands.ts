/**
 * Comandos de sistema (reiniciar workers pela tela): enums, máquina de estados e regras de validação.
 * Só a API de ADMIN cria comandos; o supervisor mapeia cada `action` para uma função fixa — nada do que está na
 * tabela é executado como texto. Mesmos valores do CHECK da migration.
 */
import { z } from "zod";

export const COMMAND_ACTIONS = ["RESTART_PROFILE", "STOP_PROFILE", "START_PROFILE", "RESTART_ALL", "RESTART_SUPERVISOR"] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export const COMMAND_MODES = ["SAFE", "IMMEDIATE"] as const;
export type CommandMode = (typeof COMMAND_MODES)[number];

export const COMMAND_STATUSES = ["PENDING", "ACCEPTED", "DRAINING", "APPLYING", "DONE", "FORCED", "FAILED", "CANCELLED", "EXPIRED"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const PENDING_EXPIRES_MS = 60 * 60 * 1000;

const TERMINAL: ReadonlySet<CommandStatus> = new Set(["DONE", "FORCED", "FAILED", "CANCELLED", "EXPIRED"]);

/** Aberto = ainda pode mudar (bloqueia outro comando igual para o mesmo perfil). */
export function isOpen(status: CommandStatus): boolean {
  return !TERMINAL.has(status);
}

const TRANSITIONS: Record<CommandStatus, readonly CommandStatus[]> = {
  PENDING: ["ACCEPTED", "CANCELLED", "EXPIRED", "FAILED"],
  ACCEPTED: ["DRAINING", "APPLYING", "DONE", "FAILED"],
  DRAINING: ["APPLYING", "DONE", "FORCED", "FAILED"],
  APPLYING: ["DONE", "FORCED", "FAILED"],
  DONE: [],
  FORCED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(from: CommandStatus, to: CommandStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Ações que exigem um perfil alvo. */
export function needsProfile(action: CommandAction): boolean {
  return action === "RESTART_PROFILE" || action === "STOP_PROFILE" || action === "START_PROFILE";
}

export const commandCreateSchema = z
  .object({
    action: z.enum(COMMAND_ACTIONS),
    mode: z.enum(COMMAND_MODES).default("SAFE"),
    profileId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(DEFAULT_COMMAND_TIMEOUT_MS),
  })
  .superRefine((c, ctx) => {
    if (needsProfile(c.action) && !c.profileId) ctx.addIssue({ code: "custom", path: ["profileId"], message: "Informe o perfil" });
    if (!needsProfile(c.action) && c.profileId) ctx.addIssue({ code: "custom", path: ["profileId"], message: "Esta ação vale para todos os workers" });
    if (c.action === "START_PROFILE" && c.mode === "IMMEDIATE") ctx.addIssue({ code: "custom", path: ["mode"], message: "Iniciar não tem modo imediato" });
  });

export type CommandInput = z.infer<typeof commandCreateSchema>;

/** Um comando aberto conflita com outro se atinge o mesmo perfil (ou se algum deles vale para todos). */
export function commandsConflict(a: { action: CommandAction; profileId: string | null }, b: { action: CommandAction; profileId: string | null }): boolean {
  const aAll = !needsProfile(a.action);
  const bAll = !needsProfile(b.action);
  return aAll || bAll || a.profileId === b.profileId;
}
