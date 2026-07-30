import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { nextRefreshFromCron } from "@/server/connections/sources";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dt = await prisma.derivedTable.findUnique({
    where: { id },
    include: { targetTable: { select: { id: true, rowCount: true, lastDataAt: true } } },
  });
  if (!dt) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  return NextResponse.json(dt);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as {
    name?: string;
    querySql?: string;
    refreshCron?: string | null;
    active?: boolean;
  };

  const dt = await prisma.derivedTable.findUnique({ where: { id } });
  if (!dt) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });

  const refreshCron = "refreshCron" in body ? body.refreshCron : dt.refreshCron;
  const nextRefreshAt = nextRefreshFromCron(refreshCron);

  const updated = await prisma.derivedTable.update({
    where: { id },
    data: {
      ...(body.name     ? { name: body.name.trim() }         : {}),
      ...(body.querySql ? { querySql: body.querySql.trim() } : {}),
      ...("refreshCron" in body ? { refreshCron, nextRefreshAt } : {}),
      ...("active"      in body ? { active: body.active }    : {}),
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dt = await prisma.derivedTable.findUnique({ where: { id } });
  if (!dt) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  await prisma.derivedTable.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
