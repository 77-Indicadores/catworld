import { prisma } from "@/server/db";

async function main() {
  const uploads = await prisma.upload.findMany({
    where: { originalFilename: { contains: "vendas_completo" } },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 5 }, dataset: { include: { project: true } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const u of uploads) {
    const totalMin = Math.round((Date.now() - u.createdAt.getTime()) / 60000);
    const updSec = Math.round((Date.now() - u.updatedAt.getTime()) / 1000);
    const dest = u.dataset ? `${u.dataset.project?.name} → ${u.dataset.name}` : "sem destino";
    console.log(`\n── ${u.originalFilename} [${dest}]`);
    console.log(`   status    : ${u.status} | progress: ${u.progress}%`);
    console.log(`   há        : ${totalMin} min | última att: ${updSec}s atrás`);
    console.log(`   tamanho   : ${(Number(u.sizeBytes) / 1024 / 1024).toFixed(1)} MB | linhas: ${u.insertedCount ?? "-"}`);
    for (const j of u.jobs) {
      const jAgo = Math.round((Date.now() - j.updatedAt.getTime()) / 1000);
      console.log(`   job       : ${j.type} | ${j.status} | att: ${j.attempts}/${j.maxAttempts} | updated: ${jAgo}s ago`);
      console.log(`   lockedBy  : ${j.lockedBy ?? "-"} | lockedAt: ${j.lockedAt ?? "-"}`);
      if (j.lastError) console.log(`   error     : ${j.lastError}`);
    }
  }
  await prisma.$disconnect();
}
main().catch(console.error);
