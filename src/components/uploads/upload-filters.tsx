"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useRef, useEffect } from "react";
import { Clock3, Loader2, CheckCircle2, CircleX, ChevronDown } from "lucide-react";
import { formatInt } from "@/lib/present";

interface Project { id: string; name: string }

interface StatusGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  activeClass: string;
  count: number;
}

interface Props {
  projects: Project[];
  selectedStatuses: string[];
  selectedProjectIds: string[];
  groupCounts: { pending: number; active: number; completed: number; failed: number };
}

export function UploadFilters({ projects, selectedStatuses, selectedProjectIds, groupCounts }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dropdownRef = useRef<HTMLDetailsElement>(null);

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  const toggleStatus = (key: string) => {
    const next = selectedStatuses.includes(key)
      ? selectedStatuses.filter((s) => s !== key)
      : [...selectedStatuses, key];
    updateParams({ status: next.length ? next.join(",") : null });
  };

  const toggleProject = (id: string) => {
    const next = selectedProjectIds.includes(id)
      ? selectedProjectIds.filter((p) => p !== id)
      : [...selectedProjectIds, id];
    updateParams({ projectId: next.length ? next.join(",") : null });
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        dropdownRef.current.removeAttribute("open");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const hasFilter = selectedStatuses.length > 0 || selectedProjectIds.length > 0;

  const statusGroups: StatusGroup[] = [
    {
      key: "pending",
      label: "Aguardando",
      icon: <Clock3 size={13} />,
      activeClass: "btn-neutral",
      count: groupCounts.pending,
    },
    {
      key: "active",
      label: "Em andamento",
      icon: <Loader2 size={13} />,
      activeClass: "btn-info",
      count: groupCounts.active,
    },
    {
      key: "completed",
      label: "Concluído",
      icon: <CheckCircle2 size={13} />,
      activeClass: "btn-success",
      count: groupCounts.completed,
    },
    {
      key: "failed",
      label: "Falhou",
      icon: <CircleX size={13} />,
      activeClass: "btn-error",
      count: groupCounts.failed,
    },
  ];

  const selectedProjectNames = projects
    .filter((p) => selectedProjectIds.includes(p.id))
    .map((p) => p.name);

  const projectLabel =
    selectedProjectIds.length === 0
      ? "Todos os projetos"
      : selectedProjectIds.length === 1
        ? selectedProjectNames[0]
        : `${selectedProjectIds.length} projetos`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {statusGroups.map((g) => {
        const active = selectedStatuses.includes(g.key);
        return (
          <button
            key={g.key}
            onClick={() => toggleStatus(g.key)}
            className={`btn btn-sm gap-1.5 ${active ? g.activeClass : "btn-ghost"}`}
          >
            {g.icon}
            {g.label}
            <span className="badge badge-sm font-mono tabular-nums">
              {formatInt(g.count)}
            </span>
          </button>
        );
      })}

      {projects.length > 0 && (
        <details ref={dropdownRef} className="dropdown">
          <summary
            className={`btn btn-sm gap-1.5 list-none ${selectedProjectIds.length ? "btn-primary" : "btn-ghost"}`}
          >
            {projectLabel}
            <ChevronDown size={13} />
          </summary>
          <ul className="dropdown-content menu menu-sm z-50 mt-1 max-h-64 w-60 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
            {projects.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-base-200">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs"
                    checked={selectedProjectIds.includes(p.id)}
                    onChange={() => toggleProject(p.id)}
                  />
                  <span className="truncate text-sm">{p.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      )}

      {hasFilter && (
        <button
          className="btn btn-ghost btn-sm text-base-content/40"
          onClick={() => updateParams({ status: null, projectId: null })}
        >
          Limpar filtros
        </button>
      )}
    </div>
  );
}
