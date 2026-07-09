import { prisma } from "@/server/db";

async function main() {
  const uploads = await prisma.upload.findMany({
    where: { status: "IMPORTING" },
    select: { id: true, originalFilename: true },
  });

  console.log(`Cancelando ${uploads.length} uploads IMPORTING...`);

  for (const u of uploads) {
    await prisma.$transaction([
      prisma.job.updateMany({
        where: { uploadId: u.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", lockedBy: null, lockedAt: null, heartbeatAt: null, lastError: "Cancelado manualmente" },
      }),
      prisma.upload.update({
        where: { id: u.id },
        data: { status: "FAILED", errorMessage: "Cancelado — reenvie o arquivo" },
      }),
    ]);
    console.log(`  ✓ ${u.originalFilename}`);
  }

  console.log("Pronto.");
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
