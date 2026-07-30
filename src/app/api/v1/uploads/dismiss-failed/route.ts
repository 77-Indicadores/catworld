import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export async function POST() {
  const result = await prisma.job.updateMany({
    where: { status: "FAILED" },
    data: { status: "COMPLETED", lastError: null },
  });

  return NextResponse.json({ dismissed: result.count });
}
