import { prisma } from "@/server/db";

async function main() {
  const r = await prisma.$queryRawUnsafe<{ weight: number }[]>(
    "SELECT TOP 3 id, type, status, weight FROM dbo.cw_jobs ORDER BY created_at DESC",
  );
  console.log("Coluna weight existe:", r.length >= 0 ? "SIM" : "NÃO");
  for (const row of r) console.log(row);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
