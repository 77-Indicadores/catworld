import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { parse } from "csv-parse";
import iconv from "iconv-lite";
import ExcelJS from "exceljs";
import { sqlIdentifier } from "@/server/security/naming";
import { hasDateTimePart, isDateLike } from "./date-normalize";

export type ParsedColumn={originalName:string;sqlName:string;sqlType:string;nullable:boolean};
export type FilePreview={columns:ParsedColumn[];rows:Record<string,unknown>[];rowCount:number;encoding:string;separator:string|null;sheetNames:string[]};
export type RowsFromFileOpts={encoding?:string;separator?:string;ext?:string};

// P3: Sample only first 50k rows for type inference — rowCount stays exact
const STATS_SAMPLE_LIMIT=50_000;

export async function previewFile(path:string):Promise<FilePreview>{
 const ext=extname(path).toLowerCase(); if(ext===".csv")return previewCsv(path); if(ext===".xlsx")return previewXlsx(path); if(ext===".xls")throw new Error("XLS legado deve ser convertido pelo worker antes da leitura"); throw new Error("Formato não suportado. Use CSV, XLSX ou XLS");
}

// P4: Read first 64 KB once to detect both encoding and separator
async function detectFileHints(path:string):Promise<{encoding:string;separator:string}>{
 const fd=await import("node:fs/promises");
 const handle=await fd.open(path,"r");
 const buffer=Buffer.alloc(65536);
 const{bytesRead}=await handle.read(buffer,0,buffer.length,0);
 await handle.close();
 const sample=buffer.subarray(0,bytesRead);

 let encoding:string;
 if(sample[0]===0xef&&sample[1]===0xbb&&sample[2]===0xbf){encoding="utf8"}
 else{try{new TextDecoder("utf-8",{fatal:true}).decode(sample);encoding="utf8"}catch{encoding="win1252"}}

 const text=iconv.decode(sample,encoding);
 const candidates=[";",",","\t"];
 const separator=candidates.map(c=>({c,score:text.split(/\r?\n/).slice(0,10).reduce((n,l)=>n+(l.split(c).length-1),0)})).sort((a,b)=>b.score-a.score)[0].c;

 return{encoding,separator};
}

function csvPipeStream(source:NodeJS.ReadableStream,encoding:string,separator:string):AsyncIterable<string[]>{
 return source.pipe(iconv.decodeStream(encoding)).pipe(parse({delimiter:separator,bom:true,relax_column_count:true,relax_quotes:true,skip_empty_lines:true})) as AsyncIterable<string[]>;
}

async function previewCsv(path:string){
 const{encoding,separator}=await detectFileHints(path);
 const sampleRows:string[][]=[];let headers:string[]=[],stats:ColumnStats[]=[],count=0;
 for await(const row of csvPipeStream(createReadStream(path),encoding,separator)){
  if(!headers.length){headers=row.map(String);stats=headers.map(newStats);continue}
  count++;
  if(sampleRows.length<20)sampleRows.push(row.map(v=>v??""));
  // P3: collect stats only for first STATS_SAMPLE_LIMIT rows
  if(count<=STATS_SAMPLE_LIMIT)headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],row[i])});
 }
 const columns=columnsFromStats(headers,stats),objects=sampleRows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null])));
 return{columns,rows:objects,rowCount:count,encoding,separator,sheetNames:[]};
}

async function previewXlsx(path:string){
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path);const sheet=workbook.worksheets[0];if(!sheet)throw new Error("Planilha sem abas");
 let headers:string[]=[],stats:ColumnStats[]=[];let sampleRows:string[][]=[];let count=0;
 sheet.eachRow({includeEmpty:true},(row,rowNumber)=>{
  const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);
  if(rowNumber===1){headers=values;stats=headers.map(newStats);return}
  count++;
  if(sampleRows.length<20)sampleRows.push(values);
  if(count<=STATS_SAMPLE_LIMIT)headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],values[i])});
 });
 // Filter out empty headers so Object.fromEntries never sees undefined keys
 const validIndices=headers.map((h,i)=>h&&h.trim()?i:-1).filter(i=>i>=0);
 headers=validIndices.map(i=>headers[i]);
 stats=validIndices.map(i=>stats[i]);
 sampleRows=sampleRows.map(row=>validIndices.map(i=>row[i]));
 const columns=columnsFromStats(headers,stats),objects=sampleRows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null])));
 return{columns,rows:objects,rowCount:count,encoding:"xlsx",separator:null,sheetNames:workbook.worksheets.map(s=>s.name)};
}

const cellValue=(value:ExcelJS.CellValue)=>value==null?"":value instanceof Date?value.toISOString():typeof value==="object"?String((value as {text?:string;result?:unknown}).text??(value as {result?:unknown}).result??""):String(value);
type ColumnStats={maxLen:number;hasNull:boolean;allInt:boolean;allDecimal:boolean;allDateLike:boolean;hasTimePart:boolean;allTime:boolean;sampleCount:number};
function newStats():ColumnStats{return{maxLen:0,hasNull:false,allInt:true,allDecimal:true,allDateLike:true,hasTimePart:false,allTime:true,sampleCount:0}}
const RE_INT=/^-?\d+$/;
const RE_INT_LEADING_ZERO=/^0\d+/;
const RE_DECIMAL=/^-?\d{1,3}(?:[.,]\d{3})*[,]\d+$|^-?\d+[.,]\d+$/;
const RE_TIME=/^\d{1,2}:\d{2}(:\d{2})?$/;
function isInt(t:string){return RE_INT.test(t)&&!RE_INT_LEADING_ZERO.test(t)}
function updateStats(s:ColumnStats,raw:unknown){
  const v=raw==null?"":String(raw),trimmed=v.trim();
  if(trimmed===""){s.hasNull=true;return}
  s.sampleCount++;
  if(v.length>s.maxLen)s.maxLen=v.length;
  if(s.allInt&&!isInt(trimmed))s.allInt=false;
  // inteiros são decimais válidos — só invalida se não for nem decimal nem inteiro
  if(s.allDecimal&&!RE_DECIMAL.test(trimmed)&&!isInt(trimmed))s.allDecimal=false;
  const dateLike=isDateLike(trimmed),dateTime=hasDateTimePart(trimmed);
  if(s.allDateLike&&!dateLike)s.allDateLike=false;
  if(dateTime)s.hasTimePart=true;
  if(s.allTime&&!RE_TIME.test(trimmed))s.allTime=false;
}
function textSqlType(maxLen:number){
 return "NVARCHAR(MAX)";
}
function columnsFromStats(headers:string[],stats:ColumnStats[]):ParsedColumn[]{const used=new Map<string,number>();return headers.map((header,index)=>{let name=sqlIdentifier(header||`col_${index+1}`);const n=(used.get(name)??0)+1;used.set(name,n);if(n>1)name=`${name}_${n}`;const s=stats[index]??newStats();const sqlType=s.sampleCount===0?"NVARCHAR(255)":s.allInt?"BIGINT":s.allDecimal?"DECIMAL(18,4)":s.allDateLike&&s.hasTimePart?"DATETIME2":s.allDateLike?"DATE":s.allTime?"TIME":textSqlType(s.maxLen);return{originalName:header,sqlName:name,sqlType,nullable:s.hasNull}})}

// P0: Accept stream in addition to file path — avoids re-downloading blob for import step.
// When source is a stream, opts.encoding + opts.separator + opts.ext are required for CSV.
export async function* rowsFromFile(
 source:string|NodeJS.ReadableStream,
 columns:ParsedColumn[],
 opts?:RowsFromFileOpts
):AsyncGenerator<Record<string,unknown>>{
 const ext=typeof source==="string"?extname(source).toLowerCase():(opts?.ext??".csv");

 if(ext===".csv"){
  let encoding:string,separator:string;
  if(typeof source==="string"){const hints=await detectFileHints(source);encoding=hints.encoding;separator=hints.separator}
  else{encoding=opts?.encoding??"utf8";separator=opts?.separator??","}
  const readable=typeof source==="string"?createReadStream(source):source;
  let header=true;
  for await(const row of csvPipeStream(readable,encoding,separator)){
   if(header){header=false;continue}
   yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null]));
  }
  return;
 }

 if(ext===".xlsx"){
  // ExcelJS WorkbookReader accepts both file path and Readable stream
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(source as string,{worksheets:"emit",sharedStrings:"cache",styles:"ignore",hyperlinks:"ignore"});
  for await(const worksheet of reader){let header=true;for await(const row of worksheet){if(header){header=false;continue}const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,values[i]??null]))}break}
  return;
 }

 throw new Error("Formato não suportado no importador");
}
