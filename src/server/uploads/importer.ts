import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type ParsedColumn } from "./parser";

export async function importUpload(uploadId:string,path:string){
 const upload=await prisma.upload.findUniqueOrThrow({where:{id:uploadId},include:{dataset:true,table:true}});
 if(!upload.dataset)throw new Error("Dataset não definido");

 // Usa mapping já confirmado pelo usuário; só faz scan completo se não houver
 const mapping=(upload.mappingJson?JSON.parse(upload.mappingJson):(await previewFile(path)).columns) as ParsedColumn[];
 // Usa rowCount salvo no preview — evita segundo scan completo do arquivo
 const knownRowCount=Number(upload.rowCount??0);

 const tableName=upload.table?.sqlName??sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/,""));
 const schema=upload.dataset.schemaName;
 const stage=`cw_stage_${upload.id.replaceAll("-","").slice(0,20)}`;
 const pool=await sqlPool();
 const target=`${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
 const staging=`${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;
 const colDefs=mapping.map(c=>`${quoteIdentifier(c.sqlName)} ${c.sqlType} ${c.nullable?"NULL":"NOT NULL"}`).join(",");

 // Compila conversor uma vez por coluna — evita checar o tipo em cada célula
 const converters=mapping.map(c=>makeConverter(c.sqlType));
 // Pré-computa definições de coluna para reusar nos bulk tables
 const bulkCols=mapping.map(c=>({name:c.sqlName,type:toSqlType(c.sqlType),opts:{nullable:c.nullable}}));

 // Cria staging fora de qualquer transação (autocommit)
 // Se já existir de uma tentativa anterior, descarta primeiro
 await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}; CREATE TABLE ${staging} (${colDefs})`);

 let total=0,inserted=0,updated=0,lastProgressMs=Date.now();

 try{
  let batch:Record<string,unknown>[]=[];

  const flush=async()=>{
   if(!batch.length)return;
   const bulk=new sql.Table(`${schema}.${stage}`);
   bulk.create=false;
   for(const col of bulkCols)bulk.columns.add(col.name,col.type,col.opts);
   for(const row of batch)bulk.rows.add(...converters.map((fn,i)=>fn(row[mapping[i]!.sqlName])));
   await new sql.Request(pool).bulk(bulk, { tableLock: true });
   total+=batch.length;
   batch=[];
   // Atualiza progresso no máximo a cada 10 segundos — evita round-trips desnecessários
   const now=Date.now();
   if(now-lastProgressMs>10_000){
    await prisma.upload.update({where:{id:upload.id},data:{progress:Math.min(90,35+Math.floor(total/Math.max(knownRowCount,1)*55))}});
    lastProgressMs=now;
   }
  };

  for await(const row of rowsFromFile(path,mapping)){batch.push(row);if(batch.length>=50_000)await flush()}
  await flush();

  // Transação curta apenas para a operação final atômica
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
    await assertCompatible(request,schema,tableName,mapping);
    await request.query(`INSERT INTO ${target} (${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")}) SELECT ${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")} FROM ${staging}; DROP TABLE ${staging}`);
    inserted=total;
   }else{
    if(!upload.keyColumn)throw new Error("Upsert exige coluna-chave");
    await assertCompatible(request,schema,tableName,mapping);
    const key=quoteIdentifier(upload.keyColumn);
    const duplicates=await request.query(`SELECT ${key},COUNT(*) n FROM ${staging} GROUP BY ${key} HAVING COUNT(*)>1`);
    if(duplicates.recordset.length)throw new Error("Arquivo contém chaves duplicadas para upsert");
    const nonKey=mapping.filter(c=>c.sqlName!==upload.keyColumn);
    const u=await request.query(`UPDATE t SET ${nonKey.map(c=>`t.${quoteIdentifier(c.sqlName)}=s.${quoteIdentifier(c.sqlName)}`).join(",")} FROM ${target} t JOIN ${staging} s ON t.${key}=s.${key}; SELECT @@ROWCOUNT updated`);
    updated=Number(u.recordset[0]?.updated??0);
    const ins=await request.query(`INSERT INTO ${target} (${mapping.map(c=>quoteIdentifier(c.sqlName)).join(",")}) SELECT ${mapping.map(c=>`s.${quoteIdentifier(c.sqlName)}`).join(",")} FROM ${staging} s WHERE NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.${key}=s.${key}); SELECT @@ROWCOUNT inserted; DROP TABLE ${staging}`);
    inserted=Number(ins.recordset[0]?.inserted??0);
   }
   const actual=Number((await request.query(`SELECT COUNT_BIG(*) count FROM ${target}`)).recordset[0].count);
   await tx.commit();
   const table=upload.table??await prisma.datasetTable.upsert({where:{datasetId_sqlName:{datasetId:upload.dataset.id,sqlName:tableName}},update:{},create:{datasetId:upload.dataset.id,name:tableName,sqlName:tableName}});
   await prisma.$transaction([prisma.datasetColumn.deleteMany({where:{tableId:table.id}}),...mapping.map((c,i)=>prisma.datasetColumn.create({data:{tableId:table.id,ordinal:i+1,originalName:c.originalName,sqlName:c.sqlName,sqlType:c.sqlType,nullable:c.nullable}})),prisma.datasetTable.update({where:{id:table.id},data:{rowCount:BigInt(actual)}}),prisma.datasetVersion.create({data:{tableId:table.id,uploadId:upload.id,rowCount:BigInt(actual),schemaJson:JSON.stringify(mapping)}}),prisma.upload.update({where:{id:upload.id},data:{tableId:table.id,status:"COMPLETED",progress:100,rowCount:BigInt(actual),insertedCount:BigInt(inserted),updatedCount:BigInt(updated)}})]);
   return{tableId:table.id,inserted,updated,rowCount:actual};
  }catch(e){await tx.rollback().catch(()=>undefined);throw e}
 }catch(e){
  // Garante limpeza da staging em caso de erro
  await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`).catch(()=>undefined);
  throw e;
 }
}

function makeConverter(type:string):(v:unknown)=>unknown{
 if(type==="BIGINT")return v=>v==null||String(v).trim()===""?null:String(v);
 if(type.startsWith("DECIMAL"))return v=>{if(v==null||String(v).trim()==="")return null;const s=String(v).trim();return Number(s.includes(",")?s.replaceAll(".","").replace(",","."):s)};
 if(type==="DATE"||type==="DATETIME2")return v=>{if(v==null||String(v).trim()==="")return null;const s=String(v).trim(),br=s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/),iso=br?`${br[3]}-${br[2]}-${br[1]}${br[4]}`:s;return new Date(type==="DATE"?iso.slice(0,10)+"T00:00:00Z":iso)};
 if(type==="TIME")return v=>v==null||String(v).trim()===""?null:String(v).trim();
 return v=>v==null||String(v).trim()===""?null:String(v);
}

function bulkTable(name:string,columns:ParsedColumn[]){const bulk=new sql.Table(name);bulk.create=false;for(const c of columns)bulk.columns.add(c.sqlName,toSqlType(c.sqlType),{nullable:c.nullable});return bulk}
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
 if(type==="TIME")return String(v).trim();
 return String(v);
}
