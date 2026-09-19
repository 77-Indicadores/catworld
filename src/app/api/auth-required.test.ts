import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * O proxy.ts NAO protege /api/*: cada rota tem que autenticar no proprio handler.
 * Este teste falha se alguem criar uma rota /api/v1 sem chamar resolveActor/requireRole/auth().
 */
const API_DIR = join(process.cwd(), "src", "app", "api");

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routes(p) : name === "route.ts" ? [p] : [];
  });
}

// Excecoes deliberadas (com o motivo):
const PUBLIC: Record<string, string> = {
  "auth/[...nextauth]/route.ts": "fluxo de login do NextAuth",
  "health/live/route.ts": "probe de liveness (nao toca dados)",
  "health/ready/route.ts": "probe de readiness (responde so o estado)",
  "health/status/route.ts": "estado publico; o detalhe exige login (resolveActor opcional)",
  "odata/[...path]/route.ts": "autentica por Basic/Bearer/api_key dentro do proprio handler",
};

describe("rotas da API exigem autenticacao", () => {
  const files = routes(API_DIR).map((f) => ({ f, rel: relative(API_DIR, f).replaceAll("\\", "/") }));

  it("encontra as rotas", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { f, rel } of files) {
    if (PUBLIC[rel]) continue;
    it(`/api/${rel.replace("/route.ts", "")}`, () => {
      const src = readFileSync(f, "utf8");
      expect(/resolveActor|requireRole|await auth\(|authenticate\(/.test(src), `${rel} nao autentica`).toBe(true);
    });
  }

  it("as excecoes publicas continuam sendo so as listadas", () => {
    for (const rel of Object.keys(PUBLIC)) expect(files.some((x) => x.rel === rel), rel).toBe(true);
  });
});
