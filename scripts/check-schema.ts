import { prisma } from "@/server/db";

async function checkDataset(filename: string) {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: filename } },
    orderBy: { updatedAt: "desc" },
    select: { originalFilename: true, mappingJson: true, status: true },
  });
  console.log(`\n── ${upload?.originalFilename} [${upload?.status}]`);
  if (upload?.mappingJson) {
    const cols = JSON.parse(upload.mappingJson) as Array<{ sqlName: string; sqlType: string }>;
    cols.forEach((c, i) => console.log(`  ${i + 1}. ${c.sqlName} → ${c.sqlType}`));
  } else {
    console.log("  (sem mappingJson)");
  }
}

async function main() {
  await checkDataset("extrato_banco_horas");
  await checkDataset("brasilmar");
  await checkDataset("funcionarios");
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
