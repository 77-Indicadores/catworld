"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ArrowUpFromLine, BookOpen, CheckCircle2, ChevronRight, CircleUserRound, CircleX, CloudCog, Database,
  FolderKanban, Home, LayoutDashboard, LogOut, Menu, Moon, ScrollText,
  Settings, Sun, X,
} from "lucide-react";

type StorageStatus = { name: string; status: string | null; latencyMs: number | null } | null;
import { ROLE_LABEL } from "@/lib/labels";
export type ShellUser = { name: string; email: string; role: string } | null;

/** `roles` ausente = todos os papéis. Espelha o que as rotas exigem (Configurações e seus filhos: só ADMIN). */
const nav: { href: string; label: string; icon: React.ElementType; roles?: string[] }[] = [
  { href: "/dashboard", label: "Visão geral", icon: LayoutDashboard },
  { href: "/projects", label: "Projetos", icon: FolderKanban },
  { href: "/uploads", label: "Uploads", icon: ArrowUpFromLine },
  { href: "/audit", label: "Auditoria", icon: ScrollText, roles: ["ADMIN", "DATA_MANAGER"] },
  { href: "/settings", label: "Configurações", icon: Settings, roles: ["ADMIN"] },
];

const CRUMB_LABEL: Record<string, string> = {
  dashboard: "Visão geral", projects: "Projetos", uploads: "Uploads", settings: "Configurações", audit: "Auditoria",
  users: "Usuários", tokens: "Tokens de API", "database-users": "Usuários SQL", "storage-servers": "Servidores SQL",
  knowledge: "Base de conhecimento", connections: "Conexões", worker: "Worker", retention: "Retenção", "sql-contract": "Contrato SQL",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const crumbLabel = (segment: string) => CRUMB_LABEL[segment] ?? (UUID.test(segment) ? "Detalhe" : decodeURIComponent(segment).replaceAll("-", " "));

const navBottom = [
  { href: "/knowledge", label: "Base de conhecimento", icon: BookOpen },
];

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function AppShell({ children, user, signOutAction }: { children: React.ReactNode; user?: ShellUser; signOutAction?: () => Promise<void> }) {
  const pathname = usePathname();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const dark = useSyncExternalStore(subscribeTheme, () => document.documentElement.getAttribute("data-theme") === "catworld-dark", () => false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>(null);

  // O tema inicial é aplicado antes da pintura por um script no layout (sem "piscar"); aqui só lemos e alternamos.
  function toggleTheme() {
    const next = !dark;
    document.documentElement.setAttribute("data-theme", next ? "catworld-dark" : "catworld");
    try { localStorage.setItem("cw-theme", next ? "dark" : "light"); } catch { /* armazenamento bloqueado: vale só nesta sessão */ }
  }

  useEffect(() => {
    if (!user) return;
    fetch("/api/v1/storage-servers")
      .then(r => (r.ok ? r.json() : null))
      .then((j: { data?: { name: string; lastStatus: string | null; lastLatencyMs: number | null; isDefault: boolean }[] } | null) => {
        const def = j?.data?.find(s => s.isDefault) ?? j?.data?.[0];
        if (def) setStorageStatus({ name: def.name, status: def.lastStatus, latencyMs: def.lastLatencyMs });
      })
      .catch(() => undefined);
  }, [user]);

  if (pathname === "/login") return <>{children}</>;

  const isWorkspace = /^\/projects\/[^/]+/.test(pathname);
  const crumbs = pathname.split("/").filter(Boolean).map(crumbLabel);
  const visibleNav = nav.filter((item) => !item.roles || (user && item.roles.includes(user.role)));

  const sidebar = isWorkspace ? null : (
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-[220px] flex-col border-r border-base-300 bg-base-100 transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-[60px] xl:w-[220px] ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className="flex h-16 items-center justify-between border-b border-base-300 px-3 xl:px-5">
          <Link href="/dashboard" className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-content shadow-sm"><Database size={19} /></span>
            <span className="xl:block hidden"><strong className="block leading-none">Catworld</strong><small className="text-[10px] uppercase tracking-[0.2em] text-base-content/45">data lake</small></span>
          </Link>
          <button aria-label="Fechar menu" className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 xl:p-3">
          <p className="hidden px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-base-content/40 xl:block">Workspace</p>
          <ul className="menu w-full gap-1 p-0">
            {visibleNav.map((item) => {
              const settingsSubpaths = ["/settings", "/storage-servers", "/users", "/tokens", "/database-users"];
              const active = item.href === "/settings"
                ? settingsSubpaths.some(p => pathname === p || pathname.startsWith(`${p}/`))
                : pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
              return (
                <li key={item.href} className="tooltip tooltip-right xl:tooltip-right" data-tip={item.label}>
                  <Link href={item.href} onClick={() => setSidebarOpen(false)} className={`flex items-center gap-3 xl:gap-2 ${active ? "active font-medium" : "text-base-content/70"}`}>
                    <item.icon size={17} className="shrink-0" /><span className="hidden xl:inline">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="my-3 border-t border-base-300" />
          <ul className="menu w-full gap-1 p-0">
            {navBottom.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href} className="tooltip tooltip-right" data-tip={item.label}>
                  <Link href={item.href} onClick={() => setSidebarOpen(false)} className={`flex items-center gap-3 xl:gap-2 ${active ? "active font-medium" : "text-base-content/70"}`}>
                    <item.icon size={17} className="shrink-0" /><span className="hidden xl:inline">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t border-base-300 p-2 xl:p-3">
          <Link href="/storage-servers" className="tooltip tooltip-right xl:tooltip-right block" data-tip={storageStatus ? `${storageStatus.name}${storageStatus.latencyMs ? ` · ${storageStatus.latencyMs}ms` : ""}` : "Servidores SQL"}>
            <div className="flex items-center justify-center gap-2 rounded-xl bg-base-200 p-3 xl:justify-start hover:bg-base-300 transition-colors">
              {storageStatus?.status === "healthy"
                ? <CheckCircle2 size={15} className="shrink-0 text-success" />
                : storageStatus?.status === "error"
                ? <CircleX size={15} className="shrink-0 text-error" />
                : <CloudCog size={15} className="shrink-0 text-base-content/40" />}
              <span className="hidden xl:block min-w-0">
                <span className="block truncate text-xs font-medium">{storageStatus?.name ?? "SQL Server"}</span>
                <p className="text-[11px] text-base-content/50">
                  {storageStatus?.status === "healthy" && storageStatus.latencyMs ? `${storageStatus.latencyMs}ms · conectado` : storageStatus?.status === "error" ? "erro de conexão" : "não testado"}
                </p>
              </span>
            </div>
          </Link>
        </div>
    </aside>
  );

  return (
    <div className={`min-h-screen ${isWorkspace ? "" : "lg:grid lg:grid-cols-[60px_1fr] xl:grid-cols-[220px_1fr]"}`}>
      {sidebarOpen && !isWorkspace && <button aria-label="Fechar menu" className="fixed inset-0 z-30 bg-neutral/35 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
      {sidebar}

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-base-300 bg-base-100/90 px-4 backdrop-blur-xl sm:px-6">
          {isWorkspace ? (
            <Link href="/projects" className="btn btn-ghost btn-sm btn-square" aria-label="Voltar para projetos"><Home size={20} /></Link>
          ) : (
            <button aria-label="Abrir menu" aria-expanded={sidebarOpen} className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button aria-label={dark ? "Usar tema claro" : "Usar tema escuro"} className="btn btn-ghost btn-sm btn-square" onClick={toggleTheme}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            {user && (
              <div className="dropdown dropdown-end">
                <button tabIndex={0} className="btn btn-ghost btn-sm gap-2" aria-label={`Conta de ${user.name}`}><CircleUserRound size={20} /><span className="hidden sm:inline">{user.name}</span></button>
                <div tabIndex={0} className="dropdown-content z-50 mt-2 w-64 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl">
                  <p className="truncate text-sm font-medium">{user.name}</p>
                  <p className="truncate text-xs text-base-content/70">{user.email}</p>
                  <p className="mt-1 text-xs text-base-content/70">{ROLE_LABEL[user.role] ?? user.role}</p>
                  {signOutAction && (
                    <form action={signOutAction} className="mt-3 border-t border-base-300 pt-3">
                      <button type="submit" className="btn btn-ghost btn-sm w-full justify-start gap-2"><LogOut size={15} />Sair</button>
                    </form>
                  )}
                </div>
              </div>
            )}
          </div>
        </header>
        {isWorkspace ? (
          <main className="overflow-hidden">{children}</main>
        ) : (
          <main className="p-4 sm:p-6 lg:p-8">
            <nav aria-label="Você está em" className="mb-5 flex items-center gap-1 text-xs text-base-content/60">
              <span>Catworld</span>
              {crumbs.map((crumb, i) => <span className="flex items-center gap-1" key={`${i}-${crumb}`}><ChevronRight size={12} /><span>{crumb}</span></span>)}
            </nav>
            <div className="mx-auto max-w-[1500px]">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
