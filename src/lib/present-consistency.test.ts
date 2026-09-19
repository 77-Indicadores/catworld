/**
 * Consistência de apresentação: data, hora e contagem são formatadas SÓ pela camada `src/lib/present/` (e por
 * `lib/fmt*.ts`). Formatação ad-hoc espalhada foi a causa de "19/09/2026" sem hora e "1.5M" no lugar de 1.487.197.
 *
 * `LEGACY` lista os arquivos que ainda formatam por conta própria; cada fase da refatoração do front tira arquivos
 * daqui. O teste falha (1) se um arquivo NOVO formatar direto e (2) se um arquivo da lista já estiver limpo (para a
 * lista só encolher).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src");
const PATTERN = /toLocaleString|toLocaleDateString|toLocaleTimeString|\.toFixed\(|Intl\.NumberFormat|Intl\.DateTimeFormat/;
const ALLOWED_DIRS = ["lib/present/"];
const ALLOWED_FILES = new Set(["lib/fmt.ts", "lib/fmt-cell.ts"]);

const LEGACY = new Set([
  "app/audit/page.tsx",
  "app/dashboard/page.tsx",
  "app/settings/retention/page.tsx",
  "app/settings/sql-contract/page.tsx",
  "app/tokens/page.tsx",
  "app/uploads/page.tsx",
  "components/settings/workers-section.tsx",
  "components/uploads/queue-lane.tsx",
  "components/uploads/source-refresh-card.tsx",
  "components/uploads/upload-card.tsx",
  "components/uploads/upload-filters.tsx",
  "components/uploads/upload-funnel.tsx",
  "components/workspace/cron-field.tsx",
  "components/workspace/dataset-panel.tsx",
  "components/workspace/project-workspace.tsx",
  "components/workspace/table-panel.tsx",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

const offenders = files(root)
  .map((f) => relative(root, f).replaceAll("\\", "/"))
  .filter((rel) => !ALLOWED_FILES.has(rel) && !ALLOWED_DIRS.some((d) => rel.startsWith(d)))
  .filter((rel) => PATTERN.test(readFileSync(join(root, rel), "utf8")));

describe("formatação de data/hora/contagem só pela camada de apresentação", () => {
  it("nenhum arquivo novo formata direto (use src/lib/present)", () => {
    expect(offenders.filter((f) => !LEGACY.has(f))).toEqual([]);
  });
  it("a lista LEGACY só encolhe: arquivo já migrado precisa sair dela", () => {
    expect([...LEGACY].filter((f) => !offenders.includes(f))).toEqual([]);
  });
});
