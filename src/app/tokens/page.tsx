import { grantLabel } from "@/lib/labels";
import { KeyRound } from "lucide-react";
import { Time } from "@/components/ui/time";
import { prisma } from "@/server/db";
import { CreateDialog } from "@/components/management/create-dialog";
import { RevokeButton } from "@/components/management/revoke-button";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { auditPageRead } from "@/server/audit-request";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof loadTokens>>[number];

async function loadTokens() {
  return prisma.apiToken.findMany({ include: { grants: true }, orderBy: { createdAt: "desc" } });
}

const columns: DataTableColumn<Row>[] = [
  { header: "Nome", cell: (t) => t.name },
  { header: "Prefixo", className: "font-mono text-xs", cell: (t) => t.prefix },
  { header: "Escopo", cell: (t) => t.grants.map(grantLabel).join(", ") || "—" },
  { header: "Último uso", cell: (t) => <Time iso={t.lastUsedAt?.toISOString()} empty="Nunca" /> },
  {
    header: "Expira",
    cell: (t) => t.expiresAt ? (
      <span className={t.expiresAt < new Date() ? "text-error" : ""}>
        <Time iso={t.expiresAt.toISOString()} />{t.expiresAt < new Date() ? " (expirado)" : ""}
      </span>
    ) : "Não expira",
  },
  {
    header: "Criado por",
    className: "text-xs",
    cell: (t) => <>{t.createdBy ?? "—"}<div className="text-base-content/65"><Time iso={t.createdAt.toISOString()} /></div></>,
  },
  {
    header: "Status",
    cell: (t) => (
      <StatusBadge
        status={t.active && !(t.expiresAt && t.expiresAt < new Date()) ? "healthy" : "inactive"}
        label={t.active ? (t.expiresAt && t.expiresAt < new Date() ? "Expirado" : "Ativo") : "Revogado"}
      />
    ),
  },
  {
    header: "",
    cell: (t) => t.active && <RevokeButton url={`/api/v1/tokens/${t.id}`} confirmText={`Revogar o token "${t.name}"? Aplicações que o usam perderão acesso imediatamente.`} />,
  },
];

export default async function TokensPage() {
  const actor = await resolveActor();
  requireRole(actor, ["ADMIN"]);
  auditPageRead(actor, "/tokens");
  const rows = await loadTokens();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Integrações"
        title="Tokens de acesso"
        description="Credenciais hash-only para a API Catworld."
        actions={<CreateDialog kind="token" triggerLabel="Novo token" />}
      />
      <Panel>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          empty={
            <EmptyState
              icon={<KeyRound size={26} />}
              title="Nenhum token criado"
              description="Crie um token para que aplicações e scripts acessem a API."
              action={<CreateDialog kind="token" triggerLabel="Novo token" />}
            />
          }
        />
      </Panel>
    </div>
  );
}
