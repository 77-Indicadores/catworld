import { createWriteStream } from "node:fs";import { mkdtemp,rm } from "node:fs/promises";import { tmpdir } from "node:os";import { basename,extname,join } from "node:path";import { pipeline } from "node:stream/promises";import { spawn } from "node:child_process";import { prisma } from "@/server/db";import { downloadFile, deleteFile } from "@/server/storage";import { env } from "@/server/env";import { previewFile } from "@/server/uploads/parser";import { importUpload } from "@/server/uploads/importer";

type Claimed={id:string;type:string;upload_id:string|null;attempts:number;max_attempts:number};let stopping=false;process.on("SIGTERM",()=>stopping=true);process.on("SIGINT",()=>stopping=true);
async function claim():Promise<Claimed|null>{const rows=await prisma.$queryRawUnsafe<Claimed[]>(`DECLARE @job TABLE(id uniqueidentifier,type varchar(50),upload_id uniqueidentifier,attempts int,max_attempts int); UPDATE TOP(1) dbo.cw_jobs WITH (UPDLOCK,READPAST,ROWLOCK) SET status='RUNNING',locked_at=SYSUTCDATETIME(),heartbeat_at=SYSUTCDATETIME(),locked_by=@P1,attempts=attempts+1 OUTPUT inserted.id,inserted.type,inserted.upload_id,inserted.attempts,inserted.max_attempts INTO @job WHERE status='QUEUED' AND available_at<=SYSUTCDATETIME(); SELECT * FROM @job`,env().CATWORLD_WORKER_ID);return rows[0]??null}
async function localFile(upload:{blobName:string;originalFilename:string}){const dir=await mkdtemp(join(tmpdir(),"catworld-")),path=join(dir,basename(upload.originalFilename));await pipeline(await downloadFile(upload.blobName),createWriteStream(path));if(extname(path).toLowerCase()!==".xls")return{dir,path};const converted=await convertLegacy(path,dir);return{dir,path:converted}}
async function convertLegacy(path:string,dir:string){await new Promise<void>((resolve,reject)=>{const child=spawn("soffice",["--headless","--convert-to","xlsx","--outdir",dir,path],{stdio:"ignore"});child.on("exit",code=>code===0?resolve():reject(new Error("Falha ao converter XLS legado com LibreOffice")));child.on("error",reject)});return join(dir,`${basename(path,".xls")}.xlsx`)}

async function work(job:Claimed){
 if(!job.upload_id)throw new Error("Job sem upload");
 const upload=await prisma.upload.findUniqueOrThrow({where:{id:job.upload_id}});
 const heartbeat=setInterval(()=>void prisma.job.update({where:{id:job.id},data:{heartbeatAt:new Date()}}),15000);
 try{
  if(job.type==="PREVIEW_UPLOAD"){
   // Preview always needs a local file (detectEncoding/detectSeparator require seekable reads)
   const file=await localFile(upload);
   try{
    await prisma.upload.update({where:{id:upload.id},data:{status:"PREVIEWING",progress:10}});
    const preview=await previewFile(file.path);
    await prisma.upload.update({where:{id:upload.id},data:{status:"AWAITING_CONFIRMATION",progress:20,previewJson:JSON.stringify(preview),rowCount:BigInt(preview.rowCount)}});
   }finally{await rm(file.dir,{recursive:true,force:true})}
  }else if(job.type==="IMPORT_UPLOAD"){
   await prisma.upload.update({where:{id:upload.id},data:{status:"IMPORTING",progress:35}});
   const ext=extname(upload.originalFilename).toLowerCase();
   const useStream=!!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING&&ext!==".xls";
   if(useStream){
    // P0: Stream directly from blob — no disk download, no re-read
    const stream=await downloadFile(upload.blobName);
    await importUpload(upload.id,stream);
   }else{
    // Local storage or XLS (needs LibreOffice conversion): download to disk first
    const file=await localFile(upload);
    try{await importUpload(upload.id,file.path)}
    finally{await rm(file.dir,{recursive:true,force:true})}
   }
   await deleteFile(upload.blobName).catch(()=>{});
  }else throw new Error(`Tipo de job desconhecido: ${job.type}`);
  await prisma.job.update({where:{id:job.id},data:{status:"COMPLETED",lockedAt:null,lockedBy:null,heartbeatAt:null}});
 }finally{clearInterval(heartbeat)}
}

async function fail(job:Claimed,error:unknown){const message=error instanceof Error?error.message:String(error),retry=job.attempts<job.max_attempts;await prisma.$transaction([prisma.job.update({where:{id:job.id},data:{status:retry?"QUEUED":"FAILED",lastError:message,availableAt:new Date(Date.now()+Math.min(job.attempts*30000,120000)),lockedAt:null,lockedBy:null}}),...(job.upload_id?[prisma.upload.update({where:{id:job.upload_id},data:{status:retry?"RETRYING":"FAILED",errorMessage:message}})]:[])]);console.error("[FAIL] upload=%s attempt=%d/%d error=%s",job.upload_id,job.attempts,job.max_attempts,message);const sqlError=error as Error&{number?:number;state?:string};if(error instanceof Error&&sqlError.number)console.error("[FAIL] sqlNumber=%d sqlState=%s",sqlError.number,sqlError.state??"");}
async function recoverStale(){await prisma.job.updateMany({where:{status:"RUNNING",heartbeatAt:{lt:new Date(Date.now()-120000)}},data:{status:"QUEUED",lockedAt:null,lockedBy:null,heartbeatAt:null,availableAt:new Date()}})}
async function main(){console.log(`Catworld worker ${env().CATWORLD_WORKER_ID} iniciado`);let lastRecovery=0;while(!stopping){if(Date.now()-lastRecovery>60000){await recoverStale();lastRecovery=Date.now()}const job=await claim();if(!job){await new Promise(r=>setTimeout(r,env().CATWORLD_JOB_POLL_MS));continue}try{await work(job)}catch(e){await fail(job,e)}}await prisma.$disconnect()}
void main().catch(e=>{console.error(e);process.exitCode=1});
