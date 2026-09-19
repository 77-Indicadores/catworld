import { z } from "zod";
import { prisma } from "@/server/db";

/** Filtros da trilha de auditoria — os mesmos na API (`GET /audit-events`) e na tela de Auditoria. */
export const auditFilterSchema = z.object({
  cursor: z.string().uuid().optional(),
  eventType: z.string().max(80).optional(),
  success: z.enum(["true", "false"]).optional(),
  userId: z.string().uuid().optional(),
  tokenId: z.string().uuid().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});
export type AuditFilters = z.infer<typeof auditFilterSchema>;

export const AUDIT_PAGE_SIZE = 100;

export async function queryAuditEvents(q: AuditFilters) {
  const rows = await prisma.auditEvent.findMany({
    where: {
      ...(q.eventType ? { eventType: q.eventType } : {}),
      ...(q.success ? { success: q.success === "true" } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.tokenId ? { tokenId: q.tokenId } : {}),
      ...(q.since || q.until ? { createdAt: { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lt: q.until } : {}) } } : {}),
    },
    take: AUDIT_PAGE_SIZE + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { user: { select: { name: true, email: true } } },
  });
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const data = hasMore ? rows.slice(0, AUDIT_PAGE_SIZE) : rows;
  return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
}

/** Nome legivel de cada tipo de evento (o codigo original continua visivel na tela). */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  API_WRITE: "Alteração pela API",
  DATA_READ: "Leitura de dados",
  ADMIN_READ: "Consulta a área administrativa",
  ACCESS_DENIED: "Acesso negado",
  AUTH_FAILED: "Falha de autenticação",
  LOGIN_SUCCESS: "Login",
  LOGIN_FAILED: "Login recusado",
  LOGOUT: "Logout",
  JOB_COMPLETED: "Tarefa concluída",
  JOB_FAILED: "Tarefa com falha",
  QUERY_EXECUTED: "Consulta SQL",
  SQL_CONTRACT_MODE_CHANGED: "Modo do contrato SQL alterado",
  UPLOAD_IMPORT_PERF: "Importação de upload",
  WORKER_STARTED: "Worker iniciado",
  WORKER_CRASHED: "Worker caiu",
  WORKER_PROFILE_CREATED: "Perfil de worker criado",
  WORKER_PROFILE_UPDATED: "Perfil de worker alterado",
  WORKER_PROFILE_DELETED: "Perfil de worker removido",
  WORKER_RESTART_REQUESTED: "Reinício de worker solicitado",
  WORKER_COMMAND_REQUESTED: "Comando de worker solicitado",
  WORKER_COMMAND_STARTED: "Comando de worker iniciado",
  WORKER_COMMAND_COMPLETED: "Comando de worker concluído",
  WORKER_COMMAND_FAILED: "Comando de worker falhou",
  WORKER_COMMAND_CANCELLED: "Comando de worker cancelado",
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Extrai os ids (uuid) citados nos eventos: no recurso (rota ou id direto) e no token que agiu. */
export function auditReferencedIds(events: { resourceId: string | null; tokenId: string | null }[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    for (const m of e.resourceId?.match(UUID_RE) ?? []) ids.add(m.toLowerCase());
    if (e.tokenId) ids.add(e.tokenId.toLowerCase());
  }
  return [...ids];
}

/**
 * Nome legivel de cada id citado nos eventos (projeto, dataset, tabela, fonte, derivada, upload, token, usuario),
 * resolvido em lote (uma consulta por tipo, nunca uma por linha). Id sem correspondencia (apagado) fica de fora.
 */
export async function resolveAuditNames(events: { resourceId: string | null; tokenId: string | null }[]): Promise<Map<string, string>> {
  const ids = auditReferencedIds(events);
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const where = { id: { in: ids } };
  const add = (rows: { id: string; label: string }[]) => { for (const r of rows) names.set(r.id.toLowerCase(), r.label); };
  const [projects, datasets, tables, sources, derived, uploads, tokens, users] = await Promise.all([
    prisma.project.findMany({ where, select: { id: true, name: true } }),
    prisma.dataset.findMany({ where, select: { id: true, name: true } }),
    prisma.datasetTable.findMany({ where, select: { id: true, name: true } }),
    prisma.datasetSource.findMany({ where, select: { id: true, name: true } }),
    prisma.derivedTable.findMany({ where, select: { id: true, name: true } }),
    prisma.upload.findMany({ where, select: { id: true, originalFilename: true } }),
    prisma.apiToken.findMany({ where, select: { id: true, name: true } }),
    prisma.user.findMany({ where, select: { id: true, name: true } }),
  ]);
  add(projects.map((r) => ({ id: r.id, label: r.name })));
  add(datasets.map((r) => ({ id: r.id, label: r.name })));
  add(tables.map((r) => ({ id: r.id, label: r.name })));
  add(sources.map((r) => ({ id: r.id, label: r.name })));
  add(derived.map((r) => ({ id: r.id, label: r.name })));
  add(uploads.map((r) => ({ id: r.id, label: r.originalFilename })));
  add(tokens.map((r) => ({ id: r.id, label: r.name })));
  add(users.map((r) => ({ id: r.id, label: r.name })));
  return names;
}

/** Recurso do evento com os ids trocados por nomes: `/api/v1/datasets/<uuid>` vira `/api/v1/datasets/Vendas`. */
export function displayResource(resourceId: string | null, resourceType: string | null, names: Map<string, string>): string {
  if (!resourceId) return resourceType ?? "—";
  return resourceId.replace(UUID_RE, (m) => names.get(m.toLowerCase()) ?? m);
}
