/**
 * A regra de expiração do arquivo original, contra Postgres real: só COMPLETED; passa do prazo OU saiu das últimas N versões.
 * Só roda com CW_TEST_PG_URL (Postgres descartável — NUNCA produção).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EXPIRED_FILES_SQL } from "./file-retention";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("EXPIRED_FILES_SQL (Postgres real)", () => {
  const pool = new Pool({ connectionString: url });
  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS cw_dataset_versions, cw_uploads;
      CREATE TABLE cw_uploads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), blob_name text, status text, created_at timestamp);
      CREATE TABLE cw_dataset_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), upload_id uuid);`);
    const ins = async (blob: string, status: string, ageDays: number, withVersion: boolean) => {
      const r = await pool.query(`INSERT INTO cw_uploads (blob_name, status, created_at) VALUES ($1,$2, NOW() - ($3 || ' days')::interval) RETURNING id`, [blob, status, String(ageDays)]);
      if (withVersion) await pool.query(`INSERT INTO cw_dataset_versions (upload_id) VALUES ($1)`, [r.rows[0].id]);
    };
    await ins("novo-com-versao", "COMPLETED", 1, true);        // fica
    await ins("velho-com-versao", "COMPLETED", 40, true);      // passou dos 30 dias
    await ins("novo-sem-versao", "COMPLETED", 1, false);       // versão podada / não mudou dados
    await ins("falhou-velho", "FAILED", 40, false);            // não é COMPLETED: fora desta regra
    await ins("importando", "IMPORTING", 40, false);           // em andamento: nunca
  });
  afterAll(async () => { await pool.query(`DROP TABLE IF EXISTS cw_dataset_versions, cw_uploads`); await pool.end(); });

  const names = async (days: number) => (await pool.query(EXPIRED_FILES_SQL, [days])).rows.map((r) => r.blob_name).sort();

  it("30 dias: expira o velho e o que não tem versão; nunca FAILED/IMPORTING", async () => {
    expect(await names(30)).toEqual(["novo-sem-versao", "velho-com-versao"]);
  });
  it("0 = não guardar: todo COMPLETED expira", async () => {
    expect(await names(0)).toEqual(["novo-com-versao", "novo-sem-versao", "velho-com-versao"]);
  });
  it("prazo longo: só sai o que não tem versão", async () => {
    expect(await names(3650)).toEqual(["novo-sem-versao"]);
  });
});
