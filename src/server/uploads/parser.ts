import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { parse } from "csv-parse";
import iconv from "iconv-lite";
import ExcelJS from "exceljs";
import { sqlIdentifier } from "@/server/security/naming";

export type ParsedColumn={originalName:string;sqlName:string;sqlType:string;nullable:boolean};
export type FilePreview={columns:ParsedColumn[];rows:Record<string,unknown>[];rowCount:number;encoding:string;separator:string|null;sheetNames:string[]};

export async function previewFile(path:string):Promise<FilePreview>{
 const ext=extname(path).toLowerCase(); if(ext===".csv")return previewCsv(path); if(ext===".xlsx")return previewXlsx(path); if(ext===".xls")throw new Error("XLS legado deve ser convertido pelo worker antes da leitura"); throw new Error("Formato não suportado. Use CSV, XLSX ou XLS");
}
function csvStream(path:string,encoding:string,separator:string):AsyncIterable<string[]>{
 return createReadStream(path).pipe(iconv.decodeStream(encoding)).pipe(parse({delimiter:separator,bom:true,relax_column_count:true,relax_quotes:true,skip_empty_lines:true})) as AsyncIterable<string[]>;
}
async function previewCsv(path:string){
 const encoding=await detectEncoding(path),separator=await detectSeparator(path,encoding),sampleRows:string[][]=[];let headers:string[]=[],stats:ColumnStats[]=[],count=0;
 for await(const row of csvStream(path,encoding,separator)){
  if(!headers.length){headers=row.map(String);stats=headers.map(newStats);continue}
  count++;
  if(sampleRows.length<20)sampleRows.push(row.map(v=>v??""));
  headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],row[i])});
 }
 const columns=columnsFromStats(headers,stats),objects=sampleRows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null])));
 return{columns,rows:objects,rowCount:count,encoding,separator,sheetNames:[]};
}
async function previewXlsx(path:string){
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path);const sheet=workbook.worksheets[0];if(!sheet)throw new Error("Planilha sem abas");
 let headers:string[]=[],stats:ColumnStats[]=[];const sampleRows:string[][]=[];let count=0;
 sheet.eachRow({includeEmpty:true},(row,rowNumber)=>{
  const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);
  if(rowNumber===1){headers=values;stats=headers.map(newStats);return}
  count++;
  if(sampleRows.length<20)sampleRows.push(values);
  headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],values[i])});
 });
 const columns=columnsFromStats(headers,stats),objects=sampleRows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null])));
 return{columns,rows:objects,rowCount:count,encoding:"xlsx",separator:null,sheetNames:workbook.worksheets.map(s=>s.name)};
}
const cellValue=(value:ExcelJS.CellValue)=>value==null?"":value instanceof Date?value.toISOString():typeof value==="object"?String((value as {text?:string;result?:unknown}).text??(value as {result?:unknown}).result??""):String(value);
type ColumnStats={maxLen:number;hasNull:boolean;allInt:boolean;allDecimal:boolean;allDate:boolean;sampleCount:number};
function newStats():ColumnStats{return{maxLen:0,hasNull:false,allInt:true,allDecimal:true,allDate:true,sampleCount:0}}
function updateStats(s:ColumnStats,raw:unknown){const v=raw==null?"":String(raw),trimmed=v.trim();if(trimmed===""){s.hasNull=true;return}s.sampleCount++;if(v.length>s.maxLen)s.maxLen=v.length;if(s.allInt&&!(/^-?\d+$/.test(trimmed)&&!/^0\d+/.test(trimmed)))s.allInt=false;if(s.allDecimal&&!(/^-?\d{1,3}(?:\.\d{3})*,\d+$|^-?\d+\.\d+$/.test(trimmed)))s.allDecimal=false;if(s.allDate&&!(/^\d{2}\/\d{2}\/\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(trimmed)))s.allDate=false}
function columnsFromStats(headers:string[],stats:ColumnStats[]):ParsedColumn[]{const used=new Map<string,number>();return headers.map((header,index)=>{let name=sqlIdentifier(header||`col_${index+1}`);const n=(used.get(name)??0)+1;used.set(name,n);if(n>1)name=`${name}_${n}`;const s=stats[index]??newStats();const sqlType=s.sampleCount===0?"NVARCHAR(255)":s.allInt?"BIGINT":s.allDecimal?"DECIMAL(18,4)":s.allDate?"DATE":s.maxLen>4000?"NVARCHAR(MAX)":`NVARCHAR(${Math.max(s.maxLen,50)})`;return{originalName:header,sqlName:name,sqlType,nullable:s.hasNull}})}
async function detectEncoding(path:string){const fd=await import("node:fs/promises");const handle=await fd.open(path,"r");const buffer=Buffer.alloc(65536);const{bytesRead}=await handle.read(buffer,0,buffer.length,0);await handle.close();const sample=buffer.subarray(0,bytesRead);if(sample[0]===0xef&&sample[1]===0xbb&&sample[2]===0xbf)return"utf8";try{new TextDecoder("utf-8",{fatal:true}).decode(sample);return"utf8"}catch{return"win1252"}}
async function detectSeparator(path:string,encoding:string){const fs=await import("node:fs/promises");const raw=await fs.readFile(path);const text=iconv.decode(raw.subarray(0,65536),encoding);const candidates=[";",",","\t"];return candidates.map(c=>({c,score:text.split(/\r?\n/).slice(0,10).reduce((n,l)=>n+(l.split(c).length-1),0)})).sort((a,b)=>b.score-a.score)[0].c}
export async function* rowsFromFile(path:string,columns:ParsedColumn[]):AsyncGenerator<Record<string,unknown>>{
 const ext=extname(path).toLowerCase();
 if(ext===".csv"){
  const encoding=await detectEncoding(path),separator=await detectSeparator(path,encoding);let header=true;
  for await(const row of csvStream(path,encoding,separator)){if(header){header=false;continue}yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null]));}
  return;
 }
 if(ext===".xlsx"){
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(path,{worksheets:"emit",sharedStrings:"cache",styles:"ignore",hyperlinks:"ignore"});
  for await(const worksheet of reader){let header=true;for await(const row of worksheet){if(header){header=false;continue}const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,values[i]??null]));}break}return;
 }
 throw new Error("Formato não suportado no importador");
}