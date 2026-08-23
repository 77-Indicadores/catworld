import { NextResponse } from "next/server";
import { checkSql } from "@/server/azure/sql";

export async function GET() {
  const sqlResult = await checkSql()
    .then(r => ({ ok: true, latencyMs: r.latencyMs, database: r.database }))
    .catch(err => ({ ok: false, error: String(err) }));

  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";

  return NextResponse.json({
    commit: commit.slice(0, 7),
    sql: sqlResult,
    time: new Date().toISOString(),
  });
}
