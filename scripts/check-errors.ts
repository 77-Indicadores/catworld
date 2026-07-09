import { prisma } from "@/server/db";

async function main() {
  const uploads = await prisma.upload.findMany({
    where: { status: "FAILED" },
    select: { originalFilename: true, errorMessage: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 15,
  });
  console.log(`\n${uploads.length} uploads FAILED:\n`);
  for (const u of uploads) {
    console.log(`── ${u.originalFilename}  [${u.updatedAt.toISOString()}]`);
    console.log(`   ${u.errorMessage?.slice(0, 400) ?? "(sem mensagem)"}`);
    console.log();
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
