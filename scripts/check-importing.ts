import { prisma } from "@/server/db";

async function main() {
  const rows = await prisma.upload.findMany({
    where: { status: "IMPORTING" },
    include: { dataset: { include: { project: true } }, jobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
  });

  for (const u of rows) {
    const j = u.jobs[0];
    const age = Math.floor((Date.now() - u.createdAt.getTime()) / 60000);
    const hbAge = j?.heartbeatAt ? Math.floor((Date.now() - j.heartbeatAt.getTime()) / 1000) : null;
    console.log(`${u.originalFilename} [${u.dataset?.project?.name}] ${(Number(u.sizeBytes)/1024/1024).toFixed(1)}MB | ${age}min | hb há ${hbAge ?? "-"}s | attempts:${j?.attempts}/${j?.maxAttempts} | locked:${j?.lockedBy ?? "-"}`);
  }

  console.log(`\nIMPORTING total: ${rows.length}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
