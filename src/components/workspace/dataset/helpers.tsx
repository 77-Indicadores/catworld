"use client";
import type { WorkspaceSource as Source, WorkspaceTable as Table } from "@/lib/workspace/types";
import { presentCount } from "@/lib/present";
import { sourceFreshness } from "@/lib/workspace/present";

// A group is either:
//   - Multiple table sources that share a sourceGroupId (batch import)
//   - A single query source (no sourceGroupId, or its own group)
export type SourceGroup =
  | { kind: "batch"; groupId: string; sources: Source[]; tables: Table[] }
  | { kind: "single"; source: Source; table: Table };

export function buildGroups(tables: Table[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const batchMap = new Map<string, { sources: Source[]; tables: Table[] }>();

  for (const t of tables) {
    const s = t.source;
    if (!s) continue;
    if (s.sourceGroupId) {
      if (!batchMap.has(s.sourceGroupId)) batchMap.set(s.sourceGroupId, { sources: [], tables: [] });
      const g = batchMap.get(s.sourceGroupId)!;
      if (!g.sources.find(x => x.id === s.id)) g.sources.push(s);
      g.tables.push(t);
    } else {
      groups.push({ kind: "single", source: s, table: t });
    }
  }

  for (const [groupId, { sources, tables: batchTables }] of batchMap) {
    groups.push({ kind: "batch", groupId, sources, tables: batchTables });
  }

  return groups;
}

export function sourceBadge(source: Source) {
  const f = sourceFreshness(source);
  return { status: f.tone, label: f.label };
}

export function refreshText(cron: string | null, autoWatch?: boolean) {
  return cron ?? (autoWatch ? "Automática (sem cron)" : "Manual");
}

export function fmtRows(n: string | null) {
  return presentCount(n)?.exact ?? null;
}

export function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-base-300 px-5 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-base-content/65">{label}</span>
      {action}
    </div>
  );
}
