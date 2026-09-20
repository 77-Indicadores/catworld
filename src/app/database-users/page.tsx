import { grantLabel } from "@/lib/labels";
import { Database } from "lucide-react";
import { prisma } from "@/server/db";
import { CreateDialog } from "@/components/management/create-dialog";
import { RevokeButton } from "@/components/management/revoke-button";
import { RotateButton } from "@/components/management/rotate-button";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { auditPageRead } from "@/server/audit-request";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof loadUsers>>[number];

async function loadUsers() {
  return prisma.databaseUser.findMany({ include: { grants: true }, orderBy: { createdAt: "desc" } });
}

const columns: DataTableColumn<Row>[] = [
  { header: "Usuário", className: "font-mono text-xs", cell: (u) => u.name },
  { header: "Tipo", cell: (u) => u.kind },
  { header: "Escopo", cell: (u) => u.grants.map(grantLabel).join(", ") || "—" },
  { header: "Status", cell: (u) => <StatusBadge status={u.active ? "healthy" : "inactive"} /> },
  {
    header: "",
    cell: (u) => u.active && (
      <div className="flex justify-end gap-1">
        <RotateButton id={u.id} />
        <RevokeButton url={`/api/v1/database-users/${u.id}`} confirmText={`Revogar o usuário SQL "${u.name}"? O login será removido do servidor de armazenamento imediatamente.`} />
      </div>
    ),
  },
];

export default async function DatabaseUsersPage() {
  const actor = await resolveActor();
  requireRole(actor, ["ADMIN"]);
  auditPageRead(actor, "/database-users");
  const rows = await loadUsers();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Acesso ao banco"
        title="Usuários do banco"
        description="Acessos diretos com grants controlados por schema."
        actions={<CreateDialog kind="database-user" triggerLabel="Novo usuário SQL" />}
      />
      <Panel>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          empty={
            <EmptyState
              icon={<Database size={26} />}
              title="Nenhum usuário SQL"
              description="Crie um usuário SQL para conectar Power BI ou aplicações direto ao banco."
              action={<CreateDialog kind="database-user" triggerLabel="Novo usuário SQL" />}
            />
          }
        />
      </Panel>
    </div>
  );
}
