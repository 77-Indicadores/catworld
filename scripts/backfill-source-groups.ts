import { randomUUID } from "crypto";
import { prisma } from "../src/server/db";

async function main() {
  const sources = await prisma.datasetSource.findMany({
    where: { sourceGroupId: null, sourceKind: "table" },
    select: { id: true, datasetId: true, connectionId: true, sourceSchema: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${sources.length} ungrouped table sources`);

  const groups = new Map<string, string[]>();
  for (const s of sources) {
    const key = `${s.datasetId}|${s.connectionId}|${s.sourceSchema ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s.id);
  }

  for (const [key, ids] of groups) {
    const groupId = randomUUID();
    await prisma.datasetSource.updateMany({
      where: { id: { in: ids } },
      data: { sourceGroupId: groupId },
    });
    const [, connectionPart, schemaPart] = key.split("|");
    console.log(`  [${ids.length} fonte(s)] conexão ${connectionPart?.slice(0, 8)}… schema=${schemaPart || "(none)"} → grupo ${groupId.slice(0, 8)}…`);
  }

  console.log(`\nDone — ${groups.size} grupo(s) criado(s)`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
