import { prisma } from "@/server/db";

async function main() {
  // Exact same condition as worker claim()
  const rows = await prisma.$queryRawUnsafe<{
    id: string; status: string; available_at: Date; attempts: number; max_attempts: number; type: string;
  }[]>(
    `SELECT TOP(10) id, type, status, available_at, attempts, max_attempts, locked_by
     FROM dbo.cw_jobs
     WHERE status='QUEUED' AND available_at<=SYSUTCDATETIME()
     ORDER BY available_at ASC`,
  );

  const now = new Date();
  console.log(`\nSYSUTCDATETIME() local equiv: ${now.toISOString()}`);
  console.log(`Jobs claimáveis (WHERE status='QUEUED' AND available_at<=SYSUTCDATETIME()): ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.type} | status=${r.status} | available_at=${(r.available_at as Date).toISOString()} | attempts=${r.attempts}/${r.max_attempts} | locked_by=${(r as unknown as { locked_by: string | null }).locked_by ?? "-"}`);
  }

  // Also check all QUEUED jobs regardless of available_at
  const all = await prisma.$queryRawUnsafe<{ id: string; status: string; available_at: Date; attempts: number }[]>(
    `SELECT TOP(20) id, type, status, available_at, attempts, max_attempts
     FROM dbo.cw_jobs
     WHERE status='QUEUED'
     ORDER BY available_at ASC`,
  );
  console.log(`\nTodos os QUEUED (sem filtro de available_at): ${all.length}`);
  for (const r of all) {
    const avail = r.available_at as Date;
    const diff = Math.ceil((avail.getTime() - now.getTime()) / 1000);
    console.log(`  status=${r.status} | available_at=${avail.toISOString()} | diff=${diff}s | attempts=${r.attempts}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
