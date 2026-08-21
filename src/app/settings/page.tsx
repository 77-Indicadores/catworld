import Link from "next/link";
import {
  Activity,
  Database,
  FileKey2,
  KeyRound,
  PlugZap,
  Server,
  Trash2,
  UsersRound,
} from "lucide-react";
import { PageHeader } from "@/components/ui/primitives";

type SettingCard = {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
};

type SettingGroup = {
  title: string;
  items: SettingCard[];
};

const groups: SettingGroup[] = [
  {
    title: "Armazenamento",
    items: [
      {
        href: "/storage-servers",
        icon: Server,
        label: "Servidores SQL",
        description: "Gerencie os servidores de armazenamento de dados (SQL Server, PostgreSQL).",
      },
      {
        href: "/settings/connections",
        icon: PlugZap,
        label: "Conexões externas",
        description: "Configure conexões com fontes de dados externas (live sources).",
      },
    ],
  },
  {
    title: "Segurança & Acesso",
    items: [
      {
        href: "/users",
        icon: UsersRound,
        label: "Usuários",
        description: "Crie, edite e controle o acesso de usuários à plataforma.",
      },
      {
        href: "/tokens",
        icon: KeyRound,
        label: "Tokens de API",
        description: "Gerencie tokens de acesso para o SDK e automações externas.",
      },
      {
        href: "/database-users",
        icon: FileKey2,
        label: "Usuários do banco",
        description: "Usuários com acesso direto ao banco via credenciais SQL.",
      },
    ],
  },
  {
    title: "Sistema",
    items: [
      {
        href: "/settings/retention",
        icon: Trash2,
        label: "Retenção de dados",
        description: "Defina por quanto tempo logs, uploads e versões de datasets são mantidos.",
      },
      {
        href: "/audit",
        icon: Activity,
        label: "Auditoria",
        description: "Visualize o histórico de ações realizadas na plataforma.",
      },
    ],
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Sistema"
        title="Configurações"
        description="Gerencie armazenamento, acessos e comportamento da plataforma."
      />

      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/40">
            {group.title}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-start gap-4 rounded-2xl border border-base-300 bg-base-100 p-5 transition-all hover:border-primary/40 hover:bg-base-200 hover:shadow-sm"
              >
                <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-base-200 text-base-content/60 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <item.icon size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium leading-snug">{item.label}</span>
                  <span className="mt-0.5 block text-sm text-base-content/55 leading-snug">
                    {item.description}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
