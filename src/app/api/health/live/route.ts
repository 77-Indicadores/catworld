import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok", service: "catworld", time: new Date().toISOString() });
}
