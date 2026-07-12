import { prisma } from "@/server/db";
import { deleteDatasetSourceGroup } from "@/server/data/catalog";

const args = new Set(process.argv.slice(2));
const deleteGroupArg = process.argv.find((arg) => arg.startsWith("--delete-group="));
const deleteGroupId = deleteGroupArg?.slice("--delete-group=".length);

async function main() {
  const orphanRunning = await prisma.datasetSource.findMany({
    where: {
      lastStatus: "running",
      NOT: {
        id: {
          in: await activeSourceJobIds(),
        },
      },
    },
    select: { id: true, name: true, sourceGroupId: true, dataset: { select: { name: true } }, connection: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
  });

  const inactiveWithTables = await prisma.datasetSource.findMany({
    where: { active: false, targetTableId: { not: null } },
    select: { id: true, name: true, sourceGroupId: true, dataset: { select: { name: true } }, connection: { select: { name: true } }, targetTable: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
  });

  console.log(JSON.stringify({
    orphanRunning,
    inactiveWithTables,
    usage: [
      "tsx scripts/repair-dataset-sources.ts",
      "tsx scripts/repair-dataset-sources.ts --fix-running",
      "tsx scripts/repair-dataset-sources.ts --delete-group=<sourceGroupId>",
    ],
  }, null, 2));

  if (args.has("--fix-running") && orphanRunning.length) {
    await prisma.datasetSource.updateMany({
      where: { id: { in: orphanRunning.map((source) => source.id) } },
      data: { lastStatus: "failed", lastError: "Processamento interrompido", nextRefreshAt: new Date() },
    });
    console.log(`fixed_running=${orphanRunning.length}`);
  }

  if (deleteGroupId) {
    const result = await deleteDatasetSourceGroup(deleteGroupId);
    console.log(JSON.stringify({ deletedGroup: deleteGroupId, ...result }, null, 2));
  }
}

async function activeSourceJobIds() {
  const jobs = await prisma.job.findMany({
    where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] } },
    select: { payloadJson: true },
  });
  return jobs.flatMap((job) => {
    try {
      const payload = JSON.parse(job.payloadJson ?? "{}") as { datasetSourceId?: string };
      return payload.datasetSourceId ? [payload.datasetSourceId] : [];
    } catch {
      return [];
    }
  });
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
