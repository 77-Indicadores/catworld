import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Stream } from "node:stream";
import ExcelJS from "exceljs";
import { detectFileHints as detectHints, csvRecords, CsvFormatError, strictDecodeStream, normalizeEncoding, type FileHints } from "./csv-detect";
import { sqlIdentifier } from "@/server/security/naming";
import { hasDateTimePart, dateCandidates, isOrderAmbiguous, type DateOrder } from "./date-normalize";
import { accumulateDecimal, decideDecimal, newDecimalAcc, type DecimalAcc, type DecSep } from "./decimal-format";
import { formatDecimalType } from "@/lib/decimal-type";

/** decimalSep/dateOrder: convenção da COLUNA decidida pelo arquivo inteiro (mapeamentos antigos não têm; ver decimal-format.ts e date-normalize.ts). *Ambiguous: ficou TEXT porque a convenção não pôde ser decidida. */
export type ParsedColumn={originalName:string;sqlName:string;sqlType:string;nullable:boolean;decimalSep?:DecSep;decimalAmbiguous?:boolean;dateOrder?:DateOrder;dateAmbiguous?:boolean};
export type FilePreview={columns:ParsedColumn[];rows:Record<string,unknown>[];rowCount:number;encoding:string;separator:string|null;sheetNames:string[]};
export type RowsFromFileOpts={encoding?:string;separator?:string;ext?:string};
export type ParseStats={parseMethod?:"duckdb"|"csv-parse"|"xlsx"|"stream";parseMs?:number;fileEncoding?:string;fileSeparator?:string;fallbackReason?:string};

export async function previewFile(path:string):Promise<FilePreview>{
 const ext=extname(path).toLowerCase(); if(ext===".csv")return previewCsv(path); if(ext===".xlsx")return previewXlsx(path); if(ext===".xls")throw new Error("XLS legado deve ser convertido pelo worker antes da leitura"); throw new Error("Formato não suportado. Use CSV, XLSX ou XLS");
}

// Encoding, dialeto e leitura estrita de registros vivem em csv-detect.ts (arquivo inteiro, sem U+FFFD em silêncio, separador sem adivinhar).
const detectFileHints=detectHints;
function csvPipeStream(source:NodeJS.ReadableStream,encoding:string,separator:string):AsyncIterable<string[]>{
 return csvRecords(source,encoding,separator);
}

async function previewCsv(path:string){
 const{encoding,separator}=await detectFileHints(path);
 const sampleRows:string[][]=[];let headers:string[]=[],stats:ColumnStats[]=[],count=0;
 for await(const row of csvPipeStream(createReadStream(path),encoding,separator)){
  if(!headers.length){headers=row.map(String);stats=headers.map(newStats);continue}
  count++;
  if(sampleRows.length<20)sampleRows.push(row.map(v=>v??""));
  headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],row[i])});
 }
 const columns=columnsFromStats(headers,stats),objects=sampleRows.map(row=>Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null])));
 return{columns,rows:objects,rowCount:count,encoding,separator,sheetNames:[]};
}

// P6: ExcelJS.stream.xlsx.WorkbookReader (streaming) foi tentado aqui pra evitar
// carregar o XLSX inteiro em memoria, mas a lib tem um bug de ordenacao interna
// (_parseWorksheet acessa this.model.sheets antes de xl/workbook.xml terminar de
// parsear, dependendo da ordem das entries do zip) que quebra em arquivos gerados
// pelo proprio ExcelJS — reproduzido em teste com um .xlsx trivial. Carregamento
// bufferizado (Workbook API) mantido; arquivos grandes devem usar CSV (rota
// totalmente streamed via DuckDB) — ver o limite de XLSX (padrao do codigo, config-contract.md),
// validado em app/api/v1/uploads/route.ts.
async function previewXlsx(path:string){
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path);const sheet=workbook.worksheets[0];if(!sheet)throw new Error("Planilha sem abas");
 let headers:string[]=[],stats:ColumnStats[]=[];let sampleRows:string[][]=[];let count=0;
 sheet.eachRow({includeEmpty:true},(row,rowNumber)=>{
  const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);
  if(rowNumber===1){headers=values;stats=headers.map(newStats);return}
  count++;
  if(sampleRows.length<20)sampleRows.push(values);
  headers.forEach((_,i)=>{stats[i]??=newStats();updateStats(stats[i],values[i])});
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
function excelSerialToIso(raw:string,type:string){
 const n=Number(raw);
 if(!Number.isFinite(n)||n<=0||n>100000)return raw;
 const ms=Math.round((n-25569)*86400*1000);
 const date=new Date(ms);
 if(Number.isNaN(date.getTime()))return raw;
 return type==="DATE"?date.toISOString().slice(0,10):date.toISOString();
}
function normalizeCellForColumn(value:string,column:ParsedColumn){
 if((column.sqlType==="DATE"||column.sqlType==="DATETIME2")&&/^\d+(\.\d+)?$/.test(value.trim()))return excelSerialToIso(value.trim(),column.sqlType);
 return value;
}
type ColumnStats={maxLen:number;hasNull:boolean;allInt:boolean;dec:DecimalAcc;okDmy:boolean;okMdy:boolean;dateAmbiguous:boolean;hasTimePart:boolean;allTime:boolean;sampleCount:number;looksIdentifier:boolean};
function newStats():ColumnStats{return{maxLen:0,hasNull:false,allInt:true,dec:newDecimalAcc(),okDmy:true,okMdy:true,dateAmbiguous:false,hasTimePart:false,allTime:true,sampleCount:0,looksIdentifier:false}}
const RE_INT=/^-?\d+$/;
// zero à esquerda, com ou sem sinal (-007 é código, não o número -7)
const RE_INT_LEADING_ZERO=/^-?0\d+/;
// hora com faixa: 25:00, 12:60 e 12:00:61 NÃO são TIME (TIP-15)
const RE_TIME=/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const BIGINT_MIN=-9223372036854775808n,BIGINT_MAX=9223372036854775807n;
function isInt(t:string){
  if(!RE_INT.test(t)||RE_INT_LEADING_ZERO.test(t))return false;
  try{const b=BigInt(t);return b>=BIGINT_MIN&&b<=BIGINT_MAX}catch{return false}
}
function updateStats(s:ColumnStats,raw:unknown){
  const v=raw==null?"":String(raw),trimmed=v.trim();
  if(trimmed===""){s.hasNull=true;return}
  s.sampleCount++;
  if(v.length>s.maxLen)s.maxLen=v.length;
  if(RE_INT.test(trimmed)&&RE_INT_LEADING_ZERO.test(trimmed))s.looksIdentifier=true;
  if(s.allInt&&!isInt(trimmed))s.allInt=false;
  // decimal: a convenção (ponto/vírgula) é decidida pela coluna inteira em columnsFromStats (decimal-format.ts)
  accumulateDecimal(s.dec,trimmed);
  const dc=dateCandidates(trimmed);
  if(dc.dmy===null)s.okDmy=false;
  if(dc.mdy===null)s.okMdy=false;
  if(isOrderAmbiguous(dc))s.dateAmbiguous=true;
  if(hasDateTimePart(trimmed))s.hasTimePart=true;
  if(s.allTime&&!RE_TIME.test(trimmed))s.allTime=false;
}
function textSqlType(){
 return "NVARCHAR(MAX)";
}
// P5: All columns are always nullable — BULK INSERT treats empty CSV fields as NULL.
//     Even columns that appear NOT NULL in sample rows can have empty/invalid values later in the file.
function headerLooksIdentifier(header:string){return /(^|[_\s-])(cpf|cnpj|cep|telefone|phone|celular|whats|codigo|cod|sku|id|documento|doc)([_\s-]|$)/i.test(header)}
function columnsFromStats(headers:string[],stats:ColumnStats[]):ParsedColumn[]{const used=new Map<string,number>();return headers.map((header,index)=>{let name=sqlIdentifier(header||`col_${index+1}`);const n=(used.get(name)??0)+1;used.set(name,n);if(n>1)name=`${name}_${n}`;const s=stats[index]??newStats();return{originalName:header,sqlName:name,...inferType(header,s),nullable:true}})}
/** Tipo da coluna a partir do arquivo INTEIRO. Nunca adivinha: ambíguo ou que não cabe exato vira texto. */
function inferType(header:string,s:ColumnStats):{sqlType:string}&Partial<Pick<ParsedColumn,"decimalSep"|"decimalAmbiguous"|"dateOrder"|"dateAmbiguous">>{
 const text={sqlType:textSqlType()};
 if(s.sampleCount===0||s.looksIdentifier||headerLooksIdentifier(header))return text;
 if(s.allInt)return{sqlType:"BIGINT"};
 const dv=decideDecimal(s.dec);
 if(dv.kind==="decimal")return{sqlType:formatDecimalType(dv.spec),decimalSep:dv.sep};
 if(dv.kind==="ambiguous")return{...text,decimalAmbiguous:true};
 if(dv.kind==="too-wide")return text;
 if(s.okDmy||s.okMdy){
  if(s.okDmy&&s.okMdy&&s.dateAmbiguous)return{...text,dateAmbiguous:true};
  return{sqlType:s.hasTimePart?"DATETIME2":"DATE",dateOrder:s.okDmy?"dmy":"mdy"};
 }
 if(s.allTime)return{sqlType:"TIME"};
 return text;
}

// Tipos canônicos aceitos como override — os mesmos que columnsFromStats pode produzir.
// DECIMAL aceita qualquer precisão/escala (ex: "DECIMAL(10,2)"), o resto é exato.
const OVERRIDABLE_TYPES = new Set(["BIGINT", "DATE", "DATETIME2", "TIME", "NVARCHAR(MAX)"]);
function isValidTypeOverride(type: string): boolean {
  return OVERRIDABLE_TYPES.has(type) || /^DECIMAL\(\d{1,2},\d{1,2}\)$/.test(type);
}

/**
 * Aplica overrides de tipo (chave = sqlName ou originalName da coluna, case-insensitive)
 * por cima da inferência automática. Overrides com nome desconhecido ou tipo inválido
 * são ignorados (não derrubam o import) — devolve a lista de nomes de fato aplicados.
 */
export function applyTypeOverrides(columns: ParsedColumn[], overrides: Record<string, string> | null | undefined): { columns: ParsedColumn[]; applied: string[]; ignored: string[] } {
  if (!overrides || !Object.keys(overrides).length) return { columns, applied: [], ignored: [] };
  const byKey = new Map<string, ParsedColumn>();
  for (const c of columns) {
    byKey.set(c.sqlName.toLowerCase(), c);
    byKey.set(c.originalName.toLowerCase(), c);
  }
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const [rawName, rawType] of Object.entries(overrides)) {
    const type = rawType.toUpperCase().trim();
    const col = byKey.get(rawName.toLowerCase());
    if (!col || !isValidTypeOverride(type)) { ignored.push(rawName); continue; }
    col.sqlType = type;
    applied.push(col.sqlName);
  }
  return { columns, applied, ignored };
}

function xlsxColumnIndices(headers:string[],columns:ParsedColumn[]){
 let cursor=0;
 return columns.map((column,index)=>{
  for(let i=cursor;i<headers.length;i++){
   if((headers[i]??"")===column.originalName){cursor=i+1;return i}
  }
  return index;
 });
}

// P0: Accept stream in addition to file path — avoids re-downloading blob for import step.
// When source is a stream, opts.encoding + opts.separator + opts.ext are required for CSV.
/** Erro do DuckDB DEPOIS de já ter entregue linhas: fatal (nunca cai no csv-parse, que recomeçaria do zero e duplicaria as linhas). */
class DuckDbMidStreamError extends Error{constructor(cause:unknown){super(cause instanceof Error?cause.message:String(cause));this.name="DuckDbMidStreamError";(this as {cause?:unknown}).cause=cause}}

/** Só o erro ANTES da 1ª linha permite o fallback para o csv-parse; depois disso vira DuckDbMidStreamError. */
async function* neverFallBackMidStream<T>(gen:AsyncGenerator<T>):AsyncGenerator<T>{
 let started=false;
 try{for await(const row of gen){started=true;yield row}}
 catch(e){throw started?new DuckDbMidStreamError(e):e}
}

export async function* rowsFromFile(
 source:string|NodeJS.ReadableStream,
 columns:ParsedColumn[],
 opts?:RowsFromFileOpts,
 stats?:ParseStats
):AsyncGenerator<Record<string,unknown>>{
 const ext=typeof source==="string"?extname(source).toLowerCase():(opts?.ext??".csv");

 if(ext===".csv"){
  // Fast path: file on disk → DuckDB com o dialeto JÁ DETECTADO (auto_detect=false): não pode discordar do preview.
  // DuckDB só lê UTF-8: outros encodings (UTF-16, Windows-1252) são transcodificados (estrito) para um arquivo temporário.
  // csv-parse é o último recurso (e o único caminho para fim de linha misto).
  if(typeof source==="string"){
   const hints:FileHints=await detectFileHints(source);
   const fileEncoding=opts?.encoding?normalizeEncoding(opts.encoding):hints.encoding;
   const separator=hints.separator;
   if(stats){stats.fileEncoding=fileEncoding;stats.fileSeparator=separator}
   const dialect={separator,headerFields:hints.headerFields,skipLines:hints.sepDirective?1:0};
   if(hints.mixedEol){
    // CRLF, LF e CR no mesmo arquivo: o csv-parse trata os tres como fim de registro; o DuckDB nao e usado (nao pode fundir registros)
    if(stats){stats.parseMethod="csv-parse";stats.fallbackReason="mixed-eol"}
   }else if(fileEncoding!=="utf8"){
    const tmpDir=await mkdtemp(join(tmpdir(),"cw-duckdb-"));
    const tmpFile=join(tmpDir,"converted.csv");
    let usedDuckDB=false;
    try{
     await pipeline(createReadStream(source),strictDecodeStream(fileEncoding),createWriteStream(tmpFile,{encoding:"utf8"}));
     const{rowsFromCsvDuckDB}=await import("./parser-duckdb");
     if(stats)stats.parseMethod="duckdb";
     const t0=Date.now();
     yield* neverFallBackMidStream(rowsFromCsvDuckDB(tmpFile,columns,dialect));
     usedDuckDB=true;
     if(stats)stats.parseMs=Date.now()-t0;
    }catch(e){
     if(e instanceof DuckDbMidStreamError)throw e; // já entregou linhas: cair no csv-parse duplicaria tudo
     if(e instanceof CsvFormatError)throw e;       // byte inválido no encoding: nunca "consertar" com caractere de substituição
     if(!usedDuckDB){if(stats){stats.parseMethod="csv-parse";stats.fallbackReason=`duckdb-failed: ${e instanceof Error?e.message.slice(0,200):String(e)}`}console.warn("[parser] DuckDB (transcodificado) falhou, usando csv-parse:",e instanceof Error?e.message:e);}
     else throw e;
    }finally{
     await rm(tmpDir,{recursive:true,force:true}).catch(()=>{});
    }
    if(usedDuckDB)return;
   }else{
    try{
     const{rowsFromCsvDuckDB}=await import("./parser-duckdb");
     if(stats)stats.parseMethod="duckdb";
     const t0=Date.now();
     yield* neverFallBackMidStream(rowsFromCsvDuckDB(source,columns,dialect));
     if(stats)stats.parseMs=Date.now()-t0;
     return;
    }catch(e){
     if(e instanceof DuckDbMidStreamError)throw e; // já entregou linhas: cair no csv-parse duplicaria tudo
     console.warn("[parser] DuckDB falhou, usando csv-parse como fallback:",e instanceof Error?e.message:e);
     if(stats){stats.parseMethod="csv-parse";stats.fallbackReason=`duckdb-failed: ${e instanceof Error?e.message.slice(0,200):String(e)}`}
    }
   }
   // csv-parse (DuckDB falhou ou não se aplica): leitura estrita — encoding sem substituição, linha com campos a mais = erro
   if(stats&&!stats.parseMethod)stats.parseMethod="csv-parse";
   const t0csv=Date.now();
   const readable=createReadStream(source);
   let header=true;
   for await(const row of csvPipeStream(readable,fileEncoding,separator)){
    if(header){header=false;continue}
    yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null]));
   }
   if(stats)stats.parseMs=Date.now()-t0csv;
   return;
  }
  // Stream source: requires opts.encoding + opts.separator
  const encoding=opts?.encoding??"utf8";
  const separator=opts?.separator??",";
  if(stats){stats.parseMethod="stream";stats.fileEncoding=encoding;stats.fileSeparator=separator}
  let header=true;
  for await(const row of csvPipeStream(source,encoding,separator)){
   if(header){header=false;continue}
   yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,row[i]??null]));
  }
  return;
 }

 if(ext===".xlsx"){
  if(stats){stats.parseMethod="xlsx";stats.fileEncoding="xlsx"}
  const t0=Date.now();
  if(typeof source==="string"){
   // Bufferizado (ExcelJS.Workbook) — ver nota em previewXlsx sobre o bug de
   // ordenacao do WorkbookReader streaming. Tamanho maximo de XLSX e limitado
   // em outra camada (actions.ts) pra conter o risco de memoria.
   const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(source);const sheet=workbook.worksheets[0];if(!sheet)return;
   let header=true,columnIndices:number[]=columns.map((_,i)=>i);
   for(const row of sheet.getRows(1,sheet.rowCount)??[]){
    const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);
    if(header){header=false;columnIndices=xlsxColumnIndices(values,columns);continue}
    yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,normalizeCellForColumn(values[columnIndices[i]!]??"",c)??null]));
   }
   if(stats)stats.parseMs=Date.now()-t0;
   return;
  }
  // ExcelJS WorkbookReader accepts both file path and Readable stream
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(source as unknown as Stream,{worksheets:"emit",sharedStrings:"cache",styles:"ignore",hyperlinks:"ignore"});
  for await(const worksheet of reader){let header=true,columnIndices:number[]=columns.map((_,i)=>i);for await(const row of worksheet){const values=(Array.isArray(row.values)?row.values.slice(1):[]).map(cellValue);if(header){header=false;columnIndices=xlsxColumnIndices(values,columns);continue}yield Object.fromEntries(columns.map((c,i)=>[c.sqlName,normalizeCellForColumn(values[columnIndices[i]!]??"",c)??null]))}break}
  if(stats)stats.parseMs=Date.now()-t0;
  return;
 }

 throw new Error("Formato não suportado no importador");
}
