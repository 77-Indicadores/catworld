import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_WORKER_ENV, legacyWorkerEnvPresent } from "./env";

describe("envs de worker legadas", () => {
  it("lista só as presentes e não vazias, com o valor", () => {
    expect(legacyWorkerEnvPresent({ CATWORLD_WORKER_ID: "w1", CATWORLD_JOB_POLL_MS: "", CATWORLD_DATABASE_URL: "x", CATWORLD_MAX_HEAVY_JOBS: "5" }))
      .toEqual([{ name: "CATWORLD_WORKER_ID", value: "w1" }, { name: "CATWORLD_MAX_HEAVY_JOBS", value: "5" }]);
    expect(legacyWorkerEnvPresent({})).toEqual([]);
  });
});

/** Regressão: nenhuma leitura das envs de worker pode voltar ao código (o dono do produto não quer nem fallback). */
describe("nenhum código lê env de worker", () => {
  const root = join(process.cwd(), "src");
  const allowed = new Set(["server/env.ts", "server/env.test.ts", "server/worker/config.test.ts"]);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  it("varre src/ atrás dos nomes removidos", () => {
    const offenders: string[] = [];
    for (const f of files(root)) {
      const rel = relative(root, f).replaceAll("\\", "/");
      if (allowed.has(rel)) continue;
      const text = readFileSync(f, "utf8");
      for (const name of LEGACY_WORKER_ENV) if (new RegExp(String.raw`(process\.env\.|env\(\)\.)${name}|\["${name}"\]`).test(text)) offenders.push(`${rel}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });
});
