import { prisma } from "@/server/db";

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      upload: { originalFilename: { in: ["rel_func_brasilmar.csv", "ifractal_funcionarios.csv", "ifractal_extrato_banco_horas.csv"] } },
    },
    orderBy: { updatedAt: "desc" },
    take: 15,
    select: {
      type: true, status: true, attempts: true, lastError: true, updatedAt: true,
      upload: { select: { originalFilename: true } },
    },
  });

  for (const j of jobs) {
    console.log(`\n── ${j.upload?.originalFilename} [${j.status}] tentativa ${j.attempts}`);
    console.log(`   ${j.lastError?.slice(0, 600) ?? "(sem erro)"}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
