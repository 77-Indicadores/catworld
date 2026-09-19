"use client";
import { useMemo, useState } from "react";
import { ChevronRight, Database, Search, Table2 } from "lucide-react";
import { qualifiedSqlName } from "@/lib/present";
import type { WorkspaceDataset } from "@/lib/workspace/types";

/** Coluna pronta para colar no T-SQL: entre colchetes se não for um identificador simples em minúsculas. */
export function columnToken(sqlName: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(sqlName) ? sqlName : `[${sqlName}]`;
}

/**
 * Navegador de tabelas e colunas para a consulta SQL: clicar numa tabela insere `schema.tabela`, numa coluna insere o
 * nome dela. Filtra por tabela ou coluna.
 */
export function SchemaBrowser({ datasets, onInsert }: { datasets: Pick<WorkspaceDataset, "id" | "name" | "schemaName" | "tables">[]; onInsert: (text: string) => void }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = filter.trim().toLowerCase();

  const filtered = useMemo(() => datasets.map((d) => ({
    ...d,
    tables: d.tables.filter((t) => !q || t.name.toLowerCase().includes(q) || t.sqlName.toLowerCase().includes(q) || t.columns.some((c) => c.sqlName.toLowerCase().includes(q))),
  })).filter((d) => d.tables.length > 0), [datasets, q]);

  const toggle = (id: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <nav aria-label="Tabelas e colunas" className="flex h-full min-h-0 flex-col text-xs">
      <label className="relative m-2 block">
        <span className="sr-only">Buscar tabela ou coluna</span>
        <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-base-content/65" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar tabela ou coluna…" className="input input-bordered input-xs w-full pl-7" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {filtered.length === 0 && <p className="px-2 py-3 text-base-content/70">Nada encontrado.</p>}
        {filtered.map((d) => (
          <div key={d.id} className="mb-1">
            <p className="flex items-center gap-1.5 px-2 py-1 font-semibold text-base-content/80"><Database size={12} className="text-primary" />{d.name}</p>
            {d.tables.map((t) => {
              const isOpen = open.has(t.id) || (q !== "" && t.columns.some((c) => c.sqlName.toLowerCase().includes(q)));
              return (
                <div key={t.id}>
                  <div className="group flex items-center rounded hover:bg-base-200">
                    <button type="button" onClick={() => toggle(t.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Recolher" : "Expandir"} colunas de ${t.name}`} className="shrink-0 p-1.5">
                      <ChevronRight size={11} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    <button type="button" onClick={() => onInsert(qualifiedSqlName(d.schemaName, t.sqlName))} title={`Inserir ${qualifiedSqlName(d.schemaName, t.sqlName)}`} className="flex flex-1 items-center gap-1.5 overflow-hidden py-1 pr-2 text-left">
                      <Table2 size={11} className="shrink-0 text-base-content/65" />
                      <span className="truncate font-mono">{t.sqlName}</span>
                    </button>
                  </div>
                  {isOpen && (
                    <ul className="ml-6 border-l border-base-300 pl-2">
                      {t.columns.map((c) => (
                        <li key={c.id}>
                          <button type="button" onClick={() => onInsert(columnToken(c.sqlName))} title={`Inserir ${columnToken(c.sqlName)}`} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-base-200">
                            <span className="truncate font-mono">{c.sqlName}</span>
                            <span className="ml-auto shrink-0 rounded bg-base-200 px-1 font-mono text-[10px] text-base-content/70">{c.sqlType.split("(")[0]}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
