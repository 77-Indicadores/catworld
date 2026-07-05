import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep === -1) continue;
    const key = t.slice(0, sep).trim();
    let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  const prisma = new PrismaClient();

  const uploads = await prisma.upload.findMany({
    where: { status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      originalFilename: true,
      mode: true,
      errorMessage: true,
      mappingJson: true,
      createdAt: true,
    },
  });

  for (const u of uploads) {
    console.log("---");
    console.log("file:", u.originalFilename, "| mode:", u.mode, "| date:", u.createdAt.toISOString());
    console.log("error:", u.errorMessage);
    const m = u.mappingJson ? JSON.parse(u.mappingJson) as Array<{sqlName:string;sqlType:string;nullable:boolean}> : null;
    console.log("mapping cols:", m ? m.length : "null");
    if (m && m.length > 0) {
      console.log("cols:", m.slice(0, 8).map(c => `${c.sqlName}:${c.sqlType}`).join(" | "), m.length > 8 ? `... +${m.length - 8}` : "");
    }
  }

  await prisma.$disconnect();
}

void main().catch(e => { console.error("ERRO:", e.message); process.exit(1); });
