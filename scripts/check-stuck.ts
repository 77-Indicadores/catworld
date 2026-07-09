import { prisma } from "@/server/db";

async function main() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const stuck = await prisma.upload.findMany({
    where: {
      status: { in: ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"] },
      createdAt: { lte: oneHourAgo },
    },
    orderBy: { createdAt: "asc" },
    include: {
      dataset: { include: { project: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  for (const u of stuck) {
    const age = Math.floor((Date.now() - u.createdAt.getTime()) / 60000);
    const dest = u.dataset ? `${u.dataset.project?.name} → ${u.dataset.name}` : "sem destino";
    const job = u.jobs[0];
    console.log(`\n── ${u.originalFilename} [${dest}]`);
    console.log(`   status       : ${u.status}`);
    console.log(`   há           : ${age} min`);
    console.log(`   tamanho      : ${(Number(u.sizeBytes) / 1024 / 1024).toFixed(1)} MB`);
    console.log(`   job type     : ${job?.type ?? "nenhum"}`);
    console.log(`   job status   : ${job?.status ?? "-"}`);
    console.log(`   job tentativas: ${job?.attempts ?? 0}/${job?.maxAttempts ?? "-"}`);
    console.log(`   job error    : ${job?.lastError ?? "-"}`);
    console.log(`   locked by    : ${job?.lockedBy ?? "-"}`);
    console.log(`   heartbeat    : ${job?.heartbeatAt?.toISOString() ?? "-"}`);
    const avail = job?.availableAt;
    const availIn = avail ? Math.ceil((avail.getTime() - Date.now()) / 1000) : null;
    console.log(`   available_at : ${avail?.toISOString() ?? "-"}${availIn !== null && availIn > 0 ? ` (em ${availIn}s)` : availIn !== null ? " (PRONTO)" : ""}`);
  }

  console.log(`\nTotal travados (>1h): ${stuck.length}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
