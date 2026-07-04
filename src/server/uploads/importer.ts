import { extname } from "node:path";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts } from "./parser";
import { bulkInsertFromBlob } from "./importer-bulk-blob";
import { env } from "@/server/env";

// P0+P1+P2+P5+P6
export async function importUpload(uploadId:string, source:string|NodeJS.ReadableStream){
 const upload=await prisma.upload.findUniqueOrThrow({where:{id:uploadId},include:{dataset:true,table:true}});
 if(!upload.dataset)throw new Error("Dataset não definido");

 const mapping=(upload.mappingJson?JSON.parse(upload.mappingJson):(await previewFile(source as string)).columns) as ParsedColumn[];
 const knownRowCount=Number(upload.rowCount??0);

 if(!mapping.length)throw new Error("Nenhuma coluna mapeada — verifique o mapeamento do arquivo");
 const tableName=upload.table?.sqlName??sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/,""));
 const schema=upload.dataset.schemaName;
 const stage=`cw_stage_${upload.id.replaceAll("-","").slice(0,20)}`;
 const pool=await sqlPool();
 const target=`${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
 const staging=`${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;
 const colDefs=mapping.map(c=>`${quoteIdentifier(c.sqlName)} ${c.sqlType} ${c.nullable?"NULL":"NOT NULL"}`).join(",");

 // P5: Validate schema compatibility BEFORE creating staging — fail fast on bad append/upsert
 if(upload.mode==="append"||upload.mode==="upsert"){
  const exists=Number((await pool.request().query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${tableName}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`)).recordset[0].ok)===1;
  if(exists)await assertCompatible(pool.request(),schema,tableName,mapping);
 }

 await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}; CREATE TABLE ${staging} (${colDefs})`);

 let total=0,inserted=0,updated=0,lastProgressMs=Date.now();

 try{
  const useBlob=!!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING;

  if(useBlob){
   // P0+P1: Stream source → convert → temp blob → BULK INSERT (no disk, no TDS overhead)
   // P2: No batch delay needed — SQL Server throttles BULK INSERT internally
   const preview=upload.previewJson?JSON.parse(upload.previewJson) as FilePreview:null;
   const ext=extname(upload.originalFilename).toLowerCase();
   const opts:RowsFromFileOpts={encoding:preview?.encoding??"utf8",separator:preview?.separator??",",ext};
   total=await bulkInsertFromBlob(uploadId,source,mapping,schema,stage,opts,(n)=>{
    const now=Date.now();
    if(now-lastProgressMs>10_000){
     void prisma.upload.update({where:{id:upload.id},data:{progress:Math.min(75,35+Math.floor(n/Math.max(knownRowCount,1)*40))}});
     lastProgressMs=now;
    }
   });
  }else{
   // Fallback: TDS bulk copy — used when blob storage is not configured (local dev)
   const batchDelay=env().CATWORLD_IMPORT_BATCH_DELAY_MS;
   const converters=mapping.map(c=>makeConverter(c.sqlType));
   const bulkCols=mapping.map(c=>({name:c.sqlName,type:toSqlType(c.sqlType),opts:{nullable:c.nullable}}));
   let batch:Record<string,unknown>[]=[];
   const flush=async()=>{
    if(!batch.length)return;
    const bulk=new sql.Table(`${schema}.${stage}`);
    bulk.create=false;
    for(const col of bulkCols)bulk.columns.add(col.name,col.type,col.opts);
    for(const row of batch)bulk.rows.add(...(converters.map((fn,i)=>fn(row[mapping[i]!.sqlName])) as Parameters<typeof bulk.rows.add>));
    await new sql.Request(pool).bulk(bulk,{tableLock:true});
    total+=batch.length;batch=[];
    if(batchDelay>0)await new Promise(r=>setTimeout(r,batchDelay));
    const now=Date.now();
    if(now-lastProgressMs>10_000){
     await prisma.upload.update({where:{id:upload.id},data:{progress:Math.min(90,35+Math.floor(total/Math.max(knownRowCount,1)*55))}});
     lastProgressMs=now;
    }
   };
   for await(const row of rowsFromFile(source as string,mapping)){batch.push(row);if(batch.length>=50_000)await flush()}
   await flush();
  }

  // Short transaction for the atomic final operation
  const tx=new sql.Transaction(pool);
  await tx.begin();
  try{
   const request=new sql.Request(tx);
   const targetExists=Number((await request.query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${tableName}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`)).recordset[0].ok)===1;
   if(upload.mode==="replace"||!targetExists){
    if(targetExists)await request.query(`DROP TABLE ${target}`);
    await request.query(`EXEC sp_rename N'${schema}.${stage}',N'${tableName}'`);
    inserted=total;
   }else if(upload.mode==="append"){
    // P5: schema already validated pre-staging — skip assertCompatible here
    await request.query(`INSERT INTO ${target} (${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")}) SELECT ${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")} FROM ${staging}; DROP TABLE ${staging}`);
    inserted=total;
   }else{
    if(!upload.keyColumn)throw new Error("Upsert exige coluna-chave");
    // P5: schema already validated pre-staging
    const key=quoteIdentifier(upload.keyColumn);
    const nonKey=mapping.filter(c=>c.sqlName!==upload.keyColumn);
    const duplicates=await request.query(`SELECT ${key},COUNT(*) n FROM ${staging} GROUP BY ${key} HAVING COUNT(*)>1`);
    if(duplicates.recordset.length)throw new Error("Arquivo contém chaves duplicadas para upsert");
    // P6: MERGE replaces separate UPDATE + INSERT — one SQL round-trip instead of two
    const whenMatched=nonKey.length>0?`WHEN MATCHED THEN UPDATE SET ${nonKey.map(c=>`t.${quoteIdentifier(c.sqlName)}=s.${quoteIdentifier(c.sqlName)}`).join(",")}`:""
    const merge=await request.query(`
      DECLARE @stats TABLE (action NVARCHAR(10));
      MERGE INTO ${target} AS t
      USING ${staging} AS s ON t.${key}=s.${key}
      ${whenMatched}
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")})
        VALUES (${mapping.map(c=>`s.${quoteIdentifier(c.sqlName)}`).join(",")})
      OUTPUT $action INTO @stats;
      SELECT
        SUM(CASE WHEN action='UPDATE' THEN 1 ELSE 0 END) updated,
        SUM(CASE WHEN action='INSERT' THEN 1 ELSE 0 END) inserted
      FROM @stats;
      DROP TABLE ${staging};
    `);
    updated=Number(merge.recordset[0]?.updated??0);
    inserted=Number(merge.recordset[0]?.inserted??0);
   }
   const actual=Number((await request.query(`SELECT COUNT_BIG(*) count FROM ${target}`)).recordset[0].count);
   await tx.commit();
   const table=upload.table??await prisma.datasetTable.upsert({where:{datasetId_sqlName:{datasetId:upload.dataset.id,sqlName:tableName}},update:{},create:{datasetId:upload.dataset.id,name:tableName,sqlName:tableName}});
   await prisma.$transaction([prisma.datasetColumn.deleteMany({where:{tableId:table.id}}),...mapping.map((c,i)=>prisma.datasetColumn.create({data:{tableId:table.id,ordinal:i+1,originalName:c.originalName,sqlName:c.sqlName,sqlType:c.sqlType,nullable:c.nullable}})),prisma.datasetTable.update({where:{id:table.id},data:{rowCount:BigInt(actual)}}),prisma.datasetVersion.create({data:{tableId:table.id,uploadId:upload.id,rowCount:BigInt(actual),schemaJson:JSON.stringify(mapping)}}),prisma.upload.update({where:{id:upload.id},data:{tableId:table.id,status:"COMPLETED",progress:100,rowCount:BigInt(actual),insertedCount:BigInt(inserted),updatedCount:BigInt(updated)}})]);
   return{tableId:table.id,inserted,updated,rowCount:actual};
  }catch(e){await tx.rollback().catch(()=>undefined);throw e}
 }catch(e){
  await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`).catch(()=>undefined);
  throw e;
 }
}

function makeConverter(type:string):(v:unknown)=>unknown{
 if(type==="BIGINT")return v=>v==null||String(v).trim()===""?null:String(v);
 if(type.startsWith("DECIMAL"))return v=>{if(v==null||String(v).trim()==="")return null;const s=String(v).trim();return Number(s.includes(",")?s.replaceAll(".","").replace(",","."):s)};
 if(type==="DATE"||type==="DATETIME2")return v=>{if(v==null||String(v).trim()==="")return null;const s=String(v).trim(),br=s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/),iso=br?`${br[3]}-${br[2]}-${br[1]}${br[4]}`:s;return new Date(type==="DATE"?iso.slice(0,10)+"T00:00:00Z":iso)};
 if(type==="TIME")return v=>{if(v==null||String(v).trim()==="")return null;const s=String(v).trim();const p=s.split(":");const h=parseInt(p[0]??"0",10),m=parseInt(p[1]??"0",10),sec=parseFloat(p[2]??"0");if(isNaN(h)||isNaN(m)||h>23)return null;return new Date(1970,0,1,h,m,Math.floor(sec),Math.round((sec%1)*1000))};
 return v=>v==null||String(v).trim()===""?null:String(v);
}

async function assertCompatible(request:sql.Request,schema:string,table:string,columns:ParsedColumn[]){const result=await request.input("schema",sql.NVarChar,schema).input("table",sql.NVarChar,table).query("SELECT c.name,t.name type_name,c.max_length,c.precision,c.scale FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");const actual=result.recordset.map(r=>String(r.name));const expected=columns.map(c=>c.sqlName);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Schema incompatível. Esperado: ${expected.join(", ")}; atual: ${actual.join(", ")}`)}
function toSqlType(type:string){if(type==="BIGINT")return sql.BigInt;if(type==="DATE")return sql.Date;if(type==="DATETIME2")return sql.DateTime2;if(type==="TIME")return sql.Time;if(type.startsWith("DECIMAL"))return sql.Decimal(18,4);const m=type.match(/NVARCHAR\((\d+)\)/);return m?sql.NVarChar(Number(m[1])):sql.NVarChar(sql.MAX)}
export function convert(v:unknown,type:string){
 if(v==null||String(v).trim()==="")return null;
 if(type==="BIGINT")return String(v);
 if(type.startsWith("DECIMAL")){const s=String(v).trim();return Number(s.includes(",")?s.replaceAll(".","").replace(",","."):s)}
 if(type==="DATE"||type==="DATETIME2"){
  const s=String(v).trim();
  const br=s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
  const iso=br?`${br[3]}-${br[2]}-${br[1]}${br[4]}`:s;
  return new Date(type==="DATE"?iso.slice(0,10)+"T00:00:00Z":iso);
 }
 if(type==="TIME"){const s=String(v).trim();const p=s.split(":");const h=parseInt(p[0]??"0",10),m=parseInt(p[1]??"0",10),sec=parseFloat(p[2]??"0");if(isNaN(h)||isNaN(m)||h>23)return null;return new Date(1970,0,1,h,m,Math.floor(sec),Math.round((sec%1)*1000))}
 return String(v);
}
