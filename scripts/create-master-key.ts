import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sql from "mssql";

const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("="); if (sep === -1) continue;
    const key = t.slice(0, sep).trim(); let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  const url = process.env["CATWORLD_DATABASE_URL"]!;
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hp, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hp!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));

  console.log(`Conectando a ${server}/${params["database"]}...`);
  const pool = await new sql.ConnectionPool({
    server: server!, port: port ? Number(port) : 1433,
    database: params["database"], user: params["user"], password: params["password"],
    options: { encrypt: true, trustServerCertificate: false },
    requestTimeout: 30000, connectionTimeout: 30000,
  }).connect();
  console.log("✓ Conectado");

  const mk = await pool.request().query("SELECT name FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'");
  if (mk.recordset.length > 0) {
    console.log("✓ Master key já existe — nada a fazer");
  } else {
    console.log("Criando master key...");
    await pool.request().query("CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'CatWorld_Mk2024!'");
    console.log("✓ Master key criada com sucesso");

    const verify = await pool.request().query("SELECT name FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'");
    console.log(verify.recordset.length > 0 ? "✓ Verificada" : "⚠ Não encontrada após criação");
  }

  await pool.close();
}

void main().catch(e => { console.error("❌", e.message); process.exit(1); });
