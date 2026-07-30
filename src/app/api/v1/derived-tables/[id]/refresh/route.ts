import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { queueDerivedRefresh } from "@/server/connections/derived";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dt = await prisma.derivedTable.findUnique({ where: { id } });
  if (!dt) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  if (!dt.active) return NextResponse.json({ error: "Tabela derivada inativa" }, { status: 409 });
  const job = await queueDerivedRefresh(id);
  return NextResponse.json({ jobId: job.id });
}
