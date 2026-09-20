import { Users as UsersIcon } from "lucide-react";
import { Time } from "@/components/ui/time";
import { ROLE_LABEL } from "@/lib/labels";
import { prisma } from "@/server/db";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { CreateUserDialog, EditUserDialog } from "@/components/management/user-dialogs";
import { ManageGrantsDialog } from "@/components/management/manage-grants-dialog";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { auditPageRead } from "@/server/audit-request";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof prisma.user.findMany>>[number];

const columns: DataTableColumn<Row>[] = [
  { header: "Nome", cell: (u) => u.name },
  { header: "Email", cell: (u) => u.email },
  { header: "Papel", cell: (u) => ROLE_LABEL[u.role] ?? u.role },
  { header: "Último login", cell: (u) => <Time iso={u.lastLoginAt?.toISOString()} empty="Nunca" /> },
  { header: "Status", cell: (u) => <StatusBadge status={u.active ? "healthy" : "inactive"} /> },
  {
    header: "",
    cell: (u) => (
      <div className="flex justify-end gap-1">
        <ManageGrantsDialog userId={u.id} userName={u.name} />
        <EditUserDialog id={u.id} name={u.name} role={u.role} active={u.active} />
      </div>
    ),
  },
];

export default async function UsersPage() {
  const actor = await resolveActor();
  requireRole(actor, ["ADMIN"]);
  auditPageRead(actor, "/users");
  const rows = await prisma.user.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Equipe"
        title="Usuários da plataforma"
        description="Contas administrativas e analíticas do Catworld."
        actions={<CreateUserDialog />}
      />
      <Panel>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          empty={
            <EmptyState
              icon={<UsersIcon size={26} />}
              title="Nenhum usuário cadastrado"
              description="Crie a primeira conta para acessar o Catworld."
              action={<CreateUserDialog />}
            />
          }
        />
      </Panel>
    </div>
  );
}
