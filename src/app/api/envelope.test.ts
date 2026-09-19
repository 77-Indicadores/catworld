import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Contrato: toda rota de dados de /api/v1 responde no envelope { data, meta, error }
 * (ok()/fail()/handleApiError). NextResponse.json direto foge do envelope.
 * Exportacao (CSV/XLSX) e stream usam Response/Blob, nao NextResponse.json.
 */
const V1 = join(process.cwd(), "src", "app", "api", "v1");

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routes(p) : name === "route.ts" ? [p] : [];
  });
}

describe("envelope { data, meta, error } em /api/v1", () => {
  for (const f of routes(V1)) {
    const rel = relative(V1, f).replaceAll("\\", "/");
    it(`v1/${rel.replace("/route.ts", "")}`, () => {
      expect(/NextResponse\.json\(/.test(readFileSync(f, "utf8")), `${rel} responde fora do envelope`).toBe(false);
    });
  }
});
