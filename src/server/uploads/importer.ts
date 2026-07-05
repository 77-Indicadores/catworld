import { extname } from "node:path";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts } from "./parser";
import { bulkInsertFromBlob } from "./importer-bulk-blob";
import { env } from "@/server/env";

const SMALL_CSV_TDS_THRESHOLD_BYTES = 1 * 1024 * 1024;

// P0+P1+P2+P5+P6
export async function importUpload(uploadId:string, source:string|NodeJS.ReadableStream){
 const importStarted=Date.now();
 const phaseTimings:Record<string,unknown>={};
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
 // _cw_rh always appended — enables Hash Diff delta on subsequent replace runs
 const colDefs=mapping.map(c=>`${quoteIdentifier(c.sqlName)} ${c.sqlType} ${c.nullable?"NULL":"NOT NULL"}`).join(",")+",[_cw_rh] CHAR(32) NULL";

 // Check target existence once — used for both schema validation and Option 2 direct replace
 const targetExists=Number((await pool.request().query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${tableName}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`)).recordset[0].ok)===1;

 // P5: Validate schema compatibility BEFORE creating staging — fail fast on bad append/upsert
 if((upload.mode==="append"||upload.mode==="upsert")&&targetExists){
  await assertCompatible(pool.request(),schema,tableName,mapping);
 }

 // Option 2 — direct replace (wide tables, no _cw_rh yet): TRUNCATE + BULK INSERT, no staging DDL
 // Option 3 Phase 1 — delta replace (server-side hash diff): full staging, EXCEPT-based delta
 // Option 3 Phase 2 — client-side delta: SDK uploads only toInsert rows; server deletes toDelete by hash list
 const hasDeltaCol=targetExists&&await checkHasDeltaCol(pool,schema,tableName);
 const schemaOk=targetExists&&await schemaMatchesSilent(pool,schema,tableName,mapping);
 const deltaReplace=upload.mode==="replace"&&hasDeltaCol&&schemaOk;
 const directReplace=false;
 // Phase 2: SDK pre-computed delta; deltaJson holds JSON array of hashes to delete
 const phase2=deltaReplace&&upload.deltaJson!=null;
 const toDelete:string[]=phase2?(JSON.parse(upload.deltaJson!) as string[]):[];

 if(directReplace){
  await pool.request().query(`TRUNCATE TABLE ${target}`);
 }else if(phase2){
  // Phase 2: SDK uploads only toInsert rows as pre-processed CSV — no staging DDL needed.
  // toInsert rows BULK INSERT directly into target; toDelete rows removed via hash list in transaction.
 }else if(!deltaReplace){
  // First import or schema change: create staging (includes _cw_rh as last col)
  await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}; CREATE TABLE ${staging} (${colDefs})`);
 }else{
  // Phase 1 delta replace: staging needed for hash comparison
  await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}; CREATE TABLE ${staging} (${colDefs})`);
 }

 let total=0,inserted=0,updated=0,lastProgressMs=Date.now();

 try{
  const ext=extname(upload.originalFilename).toLowerCase();
  const smallCsv=!phase2&&ext===".csv"&&Number(upload.sizeBytes)<=SMALL_CSV_TDS_THRESHOLD_BYTES;
  const useBlob=!!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING&&!smallCsv;

  // Phase 2 and directReplace insert into target directly; other paths use staging
  const destTable=(directReplace||phase2)?tableName:stage;

  if(useBlob){
   // P0+P1: Stream source → convert → temp blob → BULK INSERT (no disk, no TDS overhead)
   // P2: No batch delay needed — SQL Server throttles BULK INSERT internally
   const preview=upload.previewJson?JSON.parse(upload.previewJson) as FilePreview:null;
   const opts:RowsFromFileOpts={encoding:preview?.encoding??"utf8",separator:preview?.separator??",",ext};
   const blobResult=await bulkInsertFromBlob(uploadId,source,mapping,schema,destTable,opts,(n)=>{
    const now=Date.now();
    if(now-lastProgressMs>10_000){
     void prisma.upload.update({where:{id:upload.id},data:{progress:Math.min(75,35+Math.floor(n/Math.max(knownRowCount,1)*40))}});
     lastProgressMs=now;
    }
   },phase2,knownRowCount);
   total=blobResult.total;
   phaseTimings.importMethod="blob-bulk";
   phaseTimings.bulkBlob=blobResult;
  }else{
   // Fallback: TDS bulk copy — used when blob storage is not configured (local dev)
   phaseTimings.importMethod=smallCsv?"tds-small-csv":"tds-fallback";
   const batchDelay=env().CATWORLD_IMPORT_BATCH_DELAY_MS;
   const converters=mapping.map(c=>makeConverter(c.sqlType));
   const bulkCols=mapping.map(c=>({name:c.sqlName,type:toSqlType(c.sqlType),opts:{nullable:c.nullable}}));
   let batch:Record<string,unknown>[]=[];
   const tdsStarted=Date.now();
   const flush=async()=>{
    if(!batch.length)return;
    const bulk=new sql.Table(`${schema}.${destTable}`);
    bulk.create=false;
    for(const col of bulkCols)bulk.columns.add(col.name,col.type,col.opts);
    bulk.columns.add("_cw_rh",sql.Char(32),{nullable:true});
    for(const row of batch){
     const vals=converters.map((fn,i)=>fn(row[mapping[i]!.sqlName]));
     const {createHash:ch}=await import("node:crypto");
     const rh=ch("md5").update(vals.map(v=>v==null?"":String(v)).join("|")).digest("hex");
     vals.push(rh);
     bulk.rows.add(...(vals as Parameters<typeof bulk.rows.add>));
    }
    await new sql.Request(pool).bulk(bulk,{tableLock:true});
    total+=batch.length;batch=[];
    if(batchDelay>0)await new Promise(r=>setTimeout(r,batchDelay));
    const now=Date.now();
    if(now-lastProgressMs>10_000){
     await prisma.upload.update({where:{id:upload.id},data:{progress:Math.min(90,35+Math.floor(total/Math.max(knownRowCount,1)*55))}});
     lastProgressMs=now;
    }
   };
   const preview=upload.previewJson?JSON.parse(upload.previewJson) as FilePreview:null;
   const opts:RowsFromFileOpts={encoding:preview?.encoding??"utf8",separator:preview?.separator??",",ext};
   for await(const row of rowsFromFile(source,mapping,opts)){batch.push(row);if(batch.length>=50_000)await flush()}
   await flush();
   phaseTimings.tdsBulkMs=Date.now()-tdsStarted;
  }

  // Short transaction for the atomic final operation
  const tx=new sql.Transaction(pool);
  await tx.begin();
  try{
   const request=new sql.Request(tx);
   if(directReplace){
    // Option 2: data already in target via direct BULK INSERT — nothing to swap
    inserted=total;
   }else if(phase2){
    // Option 3 Phase 2: toInsert rows already in target (BULK INSERT completed above).
    // Delete toDelete hashes using a single SQL batch to avoid cross-query temp table visibility issues.
    inserted=total;
    if(toDelete.length>0){
     const BATCH=500;
     // Build the entire DELETE as one batch: CREATE #cw_del, batch INSERTs, DELETE JOIN, SELECT count
     let deleteSql="IF OBJECT_ID('tempdb..#cw_del','U') IS NOT NULL DROP TABLE #cw_del;\nCREATE TABLE #cw_del (rh CHAR(32));\n";
     for(let i=0;i<toDelete.length;i+=BATCH){
      const vals=toDelete.slice(i,i+BATCH).map(h=>`('${h}')`).join(",");
      deleteSql+=`INSERT INTO #cw_del VALUES ${vals};\n`;
     }
     // Save @@ROWCOUNT into variable before DROP so the SELECT returns delete count
     deleteSql+=`DELETE t FROM ${target} t JOIN #cw_del d ON t.[_cw_rh]=d.rh;\nDECLARE @deleted INT=@@ROWCOUNT;\nDROP TABLE #cw_del;\nSELECT @deleted deleted;`;
     const delRes=await request.query(deleteSql);
     updated=Number(delRes.recordset[0]?.deleted??0);
    }
   }else if(deltaReplace){
    // Option 3 Phase 1: INSERT new rows first (table never empty), then DELETE removed rows
    const colList=mapping.map(c=>quoteIdentifier(c.sqlName)).join(",");
    const deltaStats=await request.query(`
      DECLARE @ins INT,@del INT;
      INSERT INTO ${target} (${colList},[_cw_rh])
      SELECT ${colList},[_cw_rh] FROM ${staging} s
      WHERE NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.[_cw_rh]=s.[_cw_rh]);
      SET @ins=@@ROWCOUNT;
      DELETE t FROM ${target} t
      WHERE NOT EXISTS(SELECT 1 FROM ${staging} s WHERE s.[_cw_rh]=t.[_cw_rh]);
      SET @del=@@ROWCOUNT;
      DROP TABLE ${staging};
      SELECT @ins inserted,@del deleted;
    `);
    inserted=Number(deltaStats.recordset[0]?.inserted??0);
    updated=Number(deltaStats.recordset[0]?.deleted??0);
   }else if(upload.mode==="replace"||!targetExists){
    // First import or schema change: add index on _cw_rh before rename (carries over with table)
    await pool.request().query(`CREATE INDEX [IX__cw_rh] ON ${staging} ([_cw_rh])`);
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
   phaseTimings.totalImportMs=Date.now()-importStarted;
   console.log("[importUpload:perf]",JSON.stringify({uploadId:upload.id,file:upload.originalFilename,rows:actual,...phaseTimings}));
   await prisma.$transaction([prisma.datasetColumn.deleteMany({where:{tableId:table.id}}),...mapping.map((c,i)=>prisma.datasetColumn.create({data:{tableId:table.id,ordinal:i+1,originalName:c.originalName,sqlName:c.sqlName,sqlType:c.sqlType,nullable:c.nullable}})),prisma.datasetTable.update({where:{id:table.id},data:{rowCount:BigInt(actual)}}),prisma.datasetVersion.create({data:{tableId:table.id,uploadId:upload.id,rowCount:BigInt(actual),schemaJson:JSON.stringify(mapping)}}),prisma.auditEvent.create({data:{eventType:"UPLOAD_IMPORT_PERF",resourceType:"upload",resourceId:upload.id,detailJson:JSON.stringify({file:upload.originalFilename,rows:actual,...phaseTimings}),success:true}}),prisma.upload.update({where:{id:upload.id},data:{tableId:table.id,status:"COMPLETED",progress:100,rowCount:BigInt(actual),insertedCount:BigInt(inserted),updatedCount:BigInt(updated)}})]);
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

async function checkHasDeltaCol(pool:sql.ConnectionPool,schema:string,table:string):Promise<boolean>{
 try{
  const r=await pool.request().input("schema",sql.NVarChar,schema).input("table",sql.NVarChar,table).query("SELECT 1 ok FROM sys.columns WHERE object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) AND name='_cw_rh'");
  return r.recordset.length>0;
 }catch{return false}
}

async function schemaMatchesSilent(pool:sql.ConnectionPool,schema:string,table:string,mapping:ParsedColumn[]):Promise<boolean>{
 try{
  const result=await pool.request().input("schema",sql.NVarChar,schema).input("table",sql.NVarChar,table).query("SELECT c.name FROM sys.columns c WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");
  // Exclude _cw_rh system column from comparison
  const actual=result.recordset.map((r:Record<string,unknown>)=>String(r.name)).filter(n=>n!=="_cw_rh");
  const expected=mapping.map(c=>c.sqlName);
  return JSON.stringify(actual)===JSON.stringify(expected);
 }catch{return false}
}

async function assertCompatible(request:sql.Request,schema:string,table:string,columns:ParsedColumn[]){const result=await request.input("schema",sql.NVarChar,schema).input("table",sql.NVarChar,table).query("SELECT c.name,t.name type_name,c.max_length,c.precision,c.scale FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");const actual=result.recordset.map(r=>String(r.name)).filter((n:string)=>n!=="_cw_rh");const expected=columns.map(c=>c.sqlName);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Schema incompatível. Esperado: ${expected.join(", ")}; atual: ${actual.join(", ")}`)}
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
 if(type==="TIME")return String(v).trim();
 return String(v);
}
