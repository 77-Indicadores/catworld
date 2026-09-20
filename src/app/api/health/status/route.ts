import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { probeStorage } from "@/server/health/storage-probe";
import { resolveActor } from "@/server/auth/actor";

// Sem login: so o estado (sql.ok) — para monitores de disponibilidade. O detalhe (commit, banco, motivo da
// falha) so aparece para quem esta autenticado: hostnames e mensagens de driver nao devem ir para o publico.
export async function GET(request: NextRequest) {
  const authenticated = await resolveActor(request, { audit: false }).then(() => true, () => false);
  const sqlResult = await probeStorage()
    .then((r) => ({ ok: true as const, latencyMs: r.latencyMs, database: r.database }))
    .catch((err) => {
      console.error("[health/status] sql: %s", err instanceof Error ? err.message : String(err));
      // Mensagem de driver (host, login, firewall) nunca vai ao cliente: so um codigo generico; o detalhe esta no log acima.
      return { ok: false as const, error: "STORAGE_UNAVAILABLE" };
    });

  const time = new Date().toISOString();
  if (!authenticated) return NextResponse.json({ sql: { ok: sqlResult.ok }, time });

  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
  return NextResponse.json({ commit: commit.slice(0, 7), sql: sqlResult, time });
}
