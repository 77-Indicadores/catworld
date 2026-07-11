"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, ArrowUpFromLine, Bell, BookOpen, ChevronRight, CircleUserRound, CloudCog, Database,
  FileKey2, FolderKanban, KeyRound, LayoutDashboard, Menu, Moon, Search,
  Settings, Sun, UsersRound, X,
} from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Visão geral", icon: LayoutDashboard },
  { href: "/projects", label: "Projetos", icon: FolderKanban },
  { href: "/uploads", label: "Uploads", icon: ArrowUpFromLine },
  { href: "/users", label: "Usuários", icon: UsersRound },
  { href: "/tokens", label: "Tokens", icon: KeyRound },
  { href: "/database-users", label: "Usuários do banco", icon: FileKey2 },
  { href: "/audit", label: "Auditoria", icon: Activity },
  { href: "/settings/connections", label: "Configurações", icon: Settings },
];

const navBottom = [
  { href: "/knowledge", label: "Base de conhecimento", icon: BookOpen },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "catworld-dark" : "catworld");
  }, [dark]);

  if (pathname === "/login") return <>{children}</>;

  const isWorkspace = /^\/projects\/[^/]+/.test(pathname);
  const crumbs = pathname.split("/").filter(Boolean).map((item) => item.replaceAll("-", " "));

  const sidebar = isWorkspace ? null : (
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-[220px] flex-col border-r border-base-300 bg-base-100 transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-[60px] xl:w-[220px] ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className="flex h-16 items-center justify-between border-b border-base-300 px-3 xl:px-5">
          <Link href="/dashboard" className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-content shadow-sm"><Database size={19} /></span>
            <span className="xl:block hidden"><strong className="block leading-none">Catworld</strong><small className="text-[10px] uppercase tracking-[0.2em] text-base-content/45">data lake</small></span>
          </Link>
          <button className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 xl:p-3">
          <p className="hidden px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-base-content/40 xl:block">Workspace</p>
          <ul className="menu w-full gap-1 p-0">
            {nav.map((item) => {
              const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
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
          <div className="tooltip tooltip-right xl:tooltip-right" data-tip="Azure SQL conectado · 38ms">
            <div className="flex items-center justify-center gap-2 rounded-xl bg-base-200 p-3 xl:justify-start">
              <CloudCog size={15} className="shrink-0 text-success" />
              <span className="hidden xl:block"><span className="text-xs font-medium">Azure SQL conectado</span><p className="text-[11px] text-base-content/50">38 ms · Produção</p></span>
            </div>
          </div>
        </div>
    </aside>
  );

  return (
    <div className={`min-h-screen ${isWorkspace ? "" : "lg:grid lg:grid-cols-[60px_1fr] xl:grid-cols-[220px_1fr]"}`}>
      {sidebarOpen && !isWorkspace && <button aria-label="Fechar menu" className="fixed inset-0 z-30 bg-neutral/35 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
      {sidebar}

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-base-300 bg-base-100/90 px-4 backdrop-blur-xl sm:px-6">
          <button className={`btn btn-ghost btn-sm btn-square ${isWorkspace ? "" : "lg:hidden"}`} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <label className="input input-sm hidden w-full max-w-md items-center gap-2 bg-base-200 md:flex">
            <Search size={15} className="text-base-content/45" />
            <input type="search" placeholder="Buscar projetos, datasets ou tabelas..." className="grow" />
            <kbd className="kbd kbd-xs">⌘ K</kbd>
          </label>
          <div className="ml-auto flex items-center gap-1">
            <button aria-label="Alternar tema" className="btn btn-ghost btn-sm btn-square" onClick={() => setDark(!dark)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button aria-label="Notificações" className="btn btn-ghost btn-sm btn-square"><Bell size={18} /></button>
            <div className="dropdown dropdown-end">
              <button tabIndex={0} className="btn btn-ghost btn-sm gap-2"><CircleUserRound size={20} /><span className="hidden sm:inline">Ana Souza</span></button>
              <ul tabIndex={0} className="menu dropdown-content z-50 mt-2 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl">
                <li><a>Meu perfil</a></li><li><a>Preferências</a></li><li><a>Sair</a></li>
              </ul>
            </div>
          </div>
        </header>
        <main className="p-4 sm:p-6 lg:p-8">
          <div className="mb-5 flex items-center gap-1 text-xs capitalize text-base-content/45">
            <span>Catworld</span>
            {crumbs.map((crumb) => <span className="flex items-center gap-1" key={crumb}><ChevronRight size={12} /><span>{crumb}</span></span>)}
          </div>
          <div className="mx-auto max-w-[1500px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
