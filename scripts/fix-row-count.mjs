import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
try {
  const rows = await p.$queryRawUnsafe(`
    SELECT COUNT(*) AS cnt FROM dbo.cw_uploads
    WHERE row_count = 0 
      AND preview_json IS NOT NULL 
      AND JSON_VALUE(preview_json, '$.rowCount') IS NOT NULL
      AND CAST(JSON_VALUE(preview_json, '$.rowCount') AS BIGINT) > 0
  `);
  console.log("Uploads to fix: %s", String(rows[0].cnt));

  if (Number(rows[0].cnt) > 0) {
    const result = await p.$executeRawUnsafe(`
      UPDATE dbo.cw_uploads 
      SET row_count = CAST(JSON_VALUE(preview_json, '$.rowCount') AS BIGINT)
      WHERE row_count = 0 
        AND preview_json IS NOT NULL 
        AND JSON_VALUE(preview_json, '$.rowCount') IS NOT NULL
        AND CAST(JSON_VALUE(preview_json, '$.rowCount') AS BIGINT) > 0
    `);
    console.log("Fixed: %d uploads", result);
  }
} catch (e) { console.error(e.message); }
await p.$disconnect();
