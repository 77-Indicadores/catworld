import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { sqlIdentifier } from "@/server/security/naming";
import { nextRefreshFromCron } from "@/server/connections/sources";
import { queueDerivedRefresh } from "@/server/connections/derived";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: datasetId } = await params;
  const items = await prisma.derivedTable.findMany({
    where: { datasetId, active: true },
    orderBy: { createdAt: "asc" },
    include: { targetTable: { select: { id: true, rowCount: true, lastDataAt: true } } },
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: datasetId } = await params;
  const body = await req.json() as {
    name?: string;
    sqlName?: string;
    querySql?: string;
    refreshCron?: string | null;
    triggerNow?: boolean;
  };

  if (!body.querySql?.trim()) return NextResponse.json({ error: "querySql obrigatório" }, { status: 400 });
  if (!body.name?.trim())     return NextResponse.json({ error: "name obrigatório" }, { status: 400 });

  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) return NextResponse.json({ error: "Dataset não encontrado" }, { status: 404 });

  const sqlName = body.sqlName?.trim()
    ? sqlIdentifier(body.sqlName.trim())
    : sqlIdentifier(body.name.trim());

  const existing = await prisma.datasetTable.findFirst({ where: { datasetId, sqlName } });
  if (existing) {
    const alreadyDerived = await prisma.derivedTable.findFirst({ where: { datasetId, sqlName } });
    if (alreadyDerived) return NextResponse.json({ error: "Tabela derivada já existe" }, { status: 409 });
  }

  const nextRefreshAt = nextRefreshFromCron(body.refreshCron);

  let targetTableId: string | null = null;
  if (existing) {
    targetTableId = existing.id;
  }

  const dt = await prisma.derivedTable.create({
    data: {
      datasetId,
      targetTableId,
      name: body.name.trim(),
      sqlName,
      querySql: body.querySql.trim(),
      refreshCron: body.refreshCron ?? null,
      nextRefreshAt,
    },
  });

  if (body.triggerNow) {
    await queueDerivedRefresh(dt.id).catch((e) =>
      console.warn("[derived] queueDerivedRefresh failed: %s", e instanceof Error ? e.message : e),
    );
  }

  return NextResponse.json(dt, { status: 201 });
}
