import { Users as UsersIcon } from "lucide-react";
import { Time } from "@/components/ui/time";
import { ROLE_LABEL } from "@/lib/labels";
import { prisma } from "@/server/db";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { CreateUserDialog, EditUserDialog } from "@/components/management/user-dialogs";
import { ManageGrantsDialog } from "@/components/management/manage-grants-dialog";
import { resolveActor, requireRole } from "@/server/auth/actor";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  requireRole(await resolveActor(), ["ADMIN"]);
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
        {rows.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={26} />}
            title="Nenhum usuário cadastrado"
            description="Crie a primeira conta para acessar o Catworld."
            action={<CreateUserDialog />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Email</th>
                  <th>Papel</th>
                  <th>Último login</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Nome">{u.name}</td>
                    <td data-label="Email">{u.email}</td>
                    <td data-label="Papel">{ROLE_LABEL[u.role] ?? u.role}</td>
                    <td data-label="Último login"><Time iso={u.lastLoginAt?.toISOString()} empty="Nunca" /></td>
                    <td data-label="Status"><StatusBadge status={u.active ? "healthy" : "inactive"} /></td>
                    <td data-label="">
                      <div className="flex justify-end gap-1">
                        <ManageGrantsDialog userId={u.id} userName={u.name} />
                        <EditUserDialog id={u.id} name={u.name} role={u.role} active={u.active} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
