import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { checkSql } from "@/server/azure/sql";

// Publico (probe de orquestrador): responde so o estado. O motivo da falha vai para o log, nunca para o cliente.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await checkSql();
    return NextResponse.json({ status: "ready" });
  } catch (error) {
    console.error("[health/ready] nao pronto: %s", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ status: "not_ready" }, { status: 503 });
  }
}
