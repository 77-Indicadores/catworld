import Link from "next/link";
import { ScrollText, ShieldAlert } from "lucide-react";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { resolveActor } from "@/server/auth/actor";
import { auditPageRead } from "@/server/audit-request";
import { AUDIT_EVENT_LABELS, auditFilterSchema, queryAuditEvents } from "@/server/audit-query";
import { Time } from "@/components/ui/time";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function detailText(json: string | null): string | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(d)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
  } catch {
    return json;
  }
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await resolveActor();
  if (!(actor.type === "user" && ["ADMIN", "DATA_MANAGER"].includes(actor.role))) {
    return (
      <div className="space-y-6">
        <PageHeader title="Auditoria" />
        <Panel>
          <EmptyState
            icon={<ShieldAlert size={26} />}
            title="Sem acesso à auditoria"
            description="Somente administradores e gestores de dados podem ver a trilha de auditoria. Peça acesso a um administrador."
          />
        </Panel>
      </div>
    );
  }
  auditPageRead(actor, "/audit");

  const sp = await searchParams;
  const raw = {
    cursor: one(sp.cursor),
    eventType: one(sp.eventType),
    success: one(sp.success),
    since: one(sp.since),
    until: one(sp.until),
    userId: one(sp.userId),
    tokenId: one(sp.tokenId),
  };
  // "Até" é inclusivo no calendário: soma um dia para cobrir o dia inteiro.
  const untilDate = raw.until && !Number.isNaN(Date.parse(raw.until)) ? new Date(Date.parse(raw.until) + 24 * 3600 * 1000).toISOString() : raw.until;
  const parsed = auditFilterSchema.safeParse({ ...raw, until: untilDate });
  const filtersOk = parsed.success;
  const result = parsed.success ? await queryAuditEvents(parsed.data) : { data: [], nextCursor: null };

  const keep: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v && k !== "cursor") keep[k] = v;
  const moreHref = result.nextCursor ? `/audit?${new URLSearchParams({ ...keep, cursor: result.nextCursor }).toString()}` : null;
  const hasFilter = Object.keys(keep).length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Governança"
        title="Auditoria"
        description="Quem fez o quê, quando e de onde: alterações, leituras de dados, acessos negados, logins e tarefas do worker. Os eventos são apagados após o período definido em Configurações › Retenção."
      />

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-box border border-base-300 bg-base-100 p-4" aria-label="Filtrar eventos">
        <label className="text-sm">
          <span className="mb-1 block">Tipo de evento</span>
          <select name="eventType" defaultValue={raw.eventType ?? ""} className="select select-bordered select-sm min-w-56">
            <option value="">Todos</option>
            {Object.entries(AUDIT_EVENT_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block">Resultado</span>
          <select name="success" defaultValue={raw.success ?? ""} className="select select-bordered select-sm">
            <option value="">Todos</option>
            <option value="true">Sucesso</option>
            <option value="false">Falha ou negado</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block">De</span>
          <input type="date" name="since" defaultValue={raw.since ?? ""} className="input input-bordered input-sm" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block">Até</span>
          <input type="date" name="until" defaultValue={raw.until ?? ""} className="input input-bordered input-sm" />
        </label>
        {raw.userId && <input type="hidden" name="userId" value={raw.userId} />}
        {raw.tokenId && <input type="hidden" name="tokenId" value={raw.tokenId} />}
        <button className="btn btn-primary btn-sm" type="submit">Filtrar</button>
        {hasFilter && <Link href="/audit" className="btn btn-ghost btn-sm">Limpar filtros</Link>}
        {(raw.userId || raw.tokenId) && (
          <p className="w-full text-xs text-base-content/70">Mostrando só os eventos {raw.userId ? "deste usuário" : "deste token"}.</p>
        )}
      </form>

      {!filtersOk && (
        <div role="alert" className="alert alert-warning alert-soft">Algum filtro é inválido (data ou identificador). Ajuste e filtre de novo.</div>
      )}

      <Panel>
        {result.data.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={26} />}
            title={hasFilter ? "Nenhum evento com esses filtros" : "Ainda não há eventos"}
            description={hasFilter ? "Amplie o período ou remova algum filtro." : "Os eventos aparecem aqui assim que alguém usar o sistema."}
            action={hasFilter ? <Link href="/audit" className="btn btn-sm">Limpar filtros</Link> : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <caption className="sr-only">Eventos de auditoria, do mais recente ao mais antigo</caption>
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">Evento</th>
                  <th scope="col">Quem</th>
                  <th scope="col">Onde</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">IP</th>
                  <th scope="col">Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((e) => {
                  const detail = detailText(e.detailJson);
                  const who = e.user ? (
                    <Link className="link" href={`/audit?userId=${e.userId}`} title={e.user.email}>{e.user.name}</Link>
                  ) : e.tokenId ? (
                    <Link className="link font-mono text-xs" href={`/audit?tokenId=${e.tokenId}`}>token …{e.tokenId.slice(0, 8)}</Link>
                  ) : (
                    <span className="text-base-content/65">Sistema</span>
                  );
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-xs"><Time iso={e.createdAt.toISOString()} /></td>
                      <td>
                        <div className="text-sm">{AUDIT_EVENT_LABELS[e.eventType] ?? e.eventType}</div>
                        <div className="font-mono text-[11px] text-base-content/65">{e.eventType}</div>
                      </td>
                      <td>{who}</td>
                      <td className="max-w-64 break-all font-mono text-xs">{e.resourceId ?? e.resourceType ?? "—"}</td>
                      <td><StatusBadge status={e.success ? "healthy" : "error"} label={e.success ? "Sucesso" : "Falha"} /></td>
                      <td className="whitespace-nowrap font-mono text-xs">{e.ipAddress ?? "—"}</td>
                      <td className="text-xs">
                        {detail ? (
                          <details>
                            <summary className="cursor-pointer">Ver</summary>
                            <pre className="mt-1 max-w-72 whitespace-pre-wrap break-all font-mono text-[11px]">{detail}</pre>
                          </details>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {moreHref && (
          <div className="border-t border-base-300 p-3 text-center">
            <Link href={moreHref} className="btn btn-sm">Ver eventos mais antigos</Link>
          </div>
        )}
      </Panel>
    </div>
  );
}
