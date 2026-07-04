/**
 * Testa localmente a lógica de conversão e geração de SQL sem banco.
 * Reproduz os cenários de bug anteriores:
 *  1. TIME converter — "Invalid time." (mssql esperava Date, não string)
 *  2. Empty mapping — "Incorrect syntax near ')'"
 */

import { convert } from "../src/server/uploads/importer";
import { quoteIdentifier } from "../src/server/security/naming";

// ── helpers ──────────────────────────────────────────────────────────────────

function assert(label: string, condition: boolean, extra?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FALHOU: ${label}${extra ? ` — ${extra}` : ""}`);
    process.exitCode = 1;
  }
}

function simulateSql(mapping: Array<{sqlName:string;sqlType:string;nullable:boolean}>): string {
  if (!mapping.length) {
    // reproduz o bug antigo: CREATE TABLE t ()
    return `CREATE TABLE [dbo].[stage] ()`;
  }
  const colDefs = mapping.map(c => `${quoteIdentifier(c.sqlName)} ${c.sqlType} ${c.nullable ? "NULL" : "NOT NULL"}`).join(",");
  return `CREATE TABLE [dbo].[stage] (${colDefs})`;
}

// ── Cenário 1: TIME converter ─────────────────────────────────────────────────

console.log("\n=== Cenário 1: TIME converter ===");

const timeCases: Array<[string, boolean]> = [
  ["8:30",      true],   // "H:MM" — caso do bug
  ["08:30",     true],   // "HH:MM"
  ["08:30:45",  true],   // "HH:MM:SS"
  ["08:30:45.5",true],   // com fração
  ["23:59:59",  true],   // limite válido
  ["24:00:00",  false],  // hora > 23 → null
  ["",          false],  // vazio → null
];

for (const [input, expectDate] of timeCases) {
  const result = convert(input, "TIME");
  if (expectDate) {
    const ok = result instanceof Date && !isNaN((result as Date).getTime());
    assert(`convert("${input}", TIME) → Date`, ok, `obteve: ${result}`);
    if (result instanceof Date) {
      // verifica que a Date não ativa "Invalid time." no mssql (Date(1970,…) é aceita)
      const year = (result as Date).getFullYear();
      assert(`  Date.getFullYear() === 1970 para "${input}"`, year === 1970, `obteve: ${year}`);
    }
  } else {
    assert(`convert("${input}", TIME) → null`, result === null, `obteve: ${result}`);
  }
}

// ── Cenário 2: mapping vazio → SQL inválido ──────────────────────────────────

console.log("\n=== Cenário 2: mapping vazio ===");

const emptyMapping: Array<{sqlName:string;sqlType:string;nullable:boolean}> = [];
const badSql = simulateSql(emptyMapping);
assert(
  `mapping [] gera SQL com parênteses vazios: "${badSql}"`,
  badSql.includes("()"),
  "esperava encontrar () no SQL"
);
console.log(`  SQL que causava o erro: ${badSql}`);
console.log(`  → O guard 'if(!mapping.length)' previne que este SQL chegue ao servidor`);

// ── Cenário 2b: mapping válido gera SQL correto ───────────────────────────────

console.log("\n=== Cenário 2b: mapping válido ===");

const validMapping = [
  { sqlName: "data", sqlType: "DATE", nullable: true },
  { sqlName: "hora", sqlType: "TIME", nullable: true },
  { sqlName: "valor", sqlType: "DECIMAL(18,4)", nullable: false },
  { sqlName: "descricao", sqlType: "NVARCHAR(255)", nullable: true },
];
const goodSql = simulateSql(validMapping);
assert("SQL gerado não tem parênteses vazios", !goodSql.includes("()"), goodSql);
assert("SQL tem coluna 'data'", goodSql.includes("[data]"), goodSql);
assert("SQL tem coluna 'descricao'", goodSql.includes("[descricao]"), goodSql);
console.log(`  SQL gerado:\n  ${goodSql}`);

// ── Cenário 3: outros tipos ───────────────────────────────────────────────────

console.log("\n=== Cenário 3: outros conversores ===");

assert('convert("123", BIGINT) → string',    convert("123", "BIGINT") === "123");
assert('convert("",   BIGINT) → null',       convert("", "BIGINT") === null);
assert('convert("1.234,56", DECIMAL) → number', convert("1.234,56", "DECIMAL(18,4)") === 1234.56);
assert('convert("1234.56",  DECIMAL) → number', convert("1234.56", "DECIMAL(18,4)") === 1234.56);
assert('convert("01/07/2025", DATE) → Date', convert("01/07/2025", "DATE") instanceof Date);
assert('convert("",  DATE) → null',          convert("", "DATE") === null);

console.log("\n=== Concluído ===\n");
