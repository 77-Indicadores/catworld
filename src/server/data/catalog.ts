import { prisma } from "@/server/db";
import { datasetSchema, slugify } from "@/server/security/naming";
import { dropSchema,dropTable,ensureSchema,grantSchema } from "@/server/azure/sql";

export const projectInclude = { datasets: { where: { active: true }, include: { tables: { include: { columns: true } } } } } as const;
export async function listProjects() { return prisma.project.findMany({ where: { active: true }, include: projectInclude, orderBy: { name: "asc" } }); }
export async function createProject(input: { name: string; description?: string }) {
  return prisma.project.create({ data: { name: input.name.trim(), slug: slugify(input.name), description: input.description?.trim() || null } });
}
export async function createDataset(projectId: string, input: { name: string; description?: string }) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const slug = slugify(input.name), schemaName = datasetSchema(project.slug, slug);
  await ensureSchema(schemaName);
  const dataset=await prisma.dataset.create({ data: { projectId, name: input.name.trim(), slug, schemaName, description: input.description?.trim() || null } });
  const grants=await prisma.accessGrant.findMany({where:{OR:[{scopeType:"GLOBAL"},{scopeType:"PROJECT",projectId}]},include:{databaseUser:true}});
  for(const grant of grants){const principal=grant.userId?`cw_u_${grant.userId.replaceAll("-","").slice(0,24)}`:grant.tokenId?`cw_t_${grant.tokenId.replaceAll("-","").slice(0,24)}`:grant.databaseUser?.name;if(principal)await grantSchema(principal,schemaName,grant.permission==="READ"?"READ":"WRITE");}
  return dataset;
}

export async function deleteTable(id: string) {
  const table = await prisma.datasetTable.findUniqueOrThrow({ where: { id }, include: { dataset: true } });
  const uploads = await prisma.upload.findMany({ where: { tableId: id } });
  const uploadIds = uploads.map((u) => u.id);
  const sources = await prisma.datasetSource.findMany({ where: { targetTableId: id }, select: { id: true } });
  const sourcePayloads = sources.map((s) => JSON.stringify({ datasetSourceId: s.id }));
  await prisma.$transaction([
    prisma.job.deleteMany({ where: { uploadId: { in: uploadIds } } }),
    prisma.job.deleteMany({ where: { payloadJson: { in: sourcePayloads } } }),
    prisma.upload.deleteMany({ where: { id: { in: uploadIds } } }),
    prisma.datasetSource.deleteMany({ where: { targetTableId: id } }),
    prisma.datasetTable.delete({ where: { id } }),
  ]);
  await dropTable(table.dataset.schemaName, table.sqlName);
}

export async function deleteDataset(id: string) {
  const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id }, include: { tables: true } });
  const tableIds = dataset.tables.map((t) => t.id);
  const uploads = await prisma.upload.findMany({ where: { OR: [{ datasetId: id }, { tableId: { in: tableIds } }] } });
  const uploadIds = uploads.map((u) => u.id);
  const sources = await prisma.datasetSource.findMany({ where: { datasetId: id }, select: { id: true } });
  const sourcePayloads = sources.map((s) => JSON.stringify({ datasetSourceId: s.id }));
  await prisma.$transaction([
    prisma.job.deleteMany({ where: { uploadId: { in: uploadIds } } }),
    prisma.job.deleteMany({ where: { payloadJson: { in: sourcePayloads } } }),
    prisma.upload.deleteMany({ where: { id: { in: uploadIds } } }),
    prisma.accessGrant.deleteMany({ where: { datasetId: id } }),
    prisma.datasetSource.deleteMany({ where: { datasetId: id } }),
    prisma.datasetTable.deleteMany({ where: { datasetId: id } }),
    prisma.dataset.delete({ where: { id } }),
  ]);
  await dropSchema(dataset.schemaName);
}

export async function deleteProject(id: string) {
  const datasets = await prisma.dataset.findMany({ where: { projectId: id } });
  for (const dataset of datasets) await deleteDataset(dataset.id);
  await prisma.$transaction([
    prisma.accessGrant.deleteMany({ where: { projectId: id } }),
    prisma.project.delete({ where: { id } }),
  ]);
}
