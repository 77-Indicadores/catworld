import { prisma } from "@/server/db";

async function main() {
  try {
    await prisma.$executeRawUnsafe(
      "ALTER TABLE [dbo].[cw_jobs] ADD [weight] TINYINT NOT NULL CONSTRAINT [cw_jobs_weight_df] DEFAULT 0",
    );
    console.log("ALTER TABLE ok");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("already") || msg.includes("Duplicate") || msg.includes("Column names")) {
      console.log("Coluna já existe, pulando ALTER");
    } else {
      throw e;
    }
  }

  const n = await prisma.$executeRawUnsafe(
    "UPDATE [dbo].[cw_jobs] SET [weight]=2 WHERE [status] IN ('QUEUED','RUNNING') AND [type]='IMPORT_UPLOAD'",
  );
  console.log(`UPDATE ok — ${n} jobs existentes marcados como pesados`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
