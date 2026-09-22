import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { translateTsql } from "./translate";

const url = process.env.CW_TEST_PG_URL;
(url ? describe : describe.skip)("TOP em UNION (CTE, derivada, IN) roda no Postgres", () => {
  it("SQL valido no PG", async () => {
    const pool = new Pool({ connectionString: url });
    const sch = `tu_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${sch}; CREATE TABLE ${sch}.t(a int); CREATE TABLE ${sch}.u(a int); INSERT INTO ${sch}.t VALUES (1),(2),(3); INSERT INTO ${sch}.u VALUES (9)`);
    try {
      for (const q of [
        "WITH c AS (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u) SELECT * FROM c",
        "SELECT * FROM (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u) d",
        "SELECT a FROM t WHERE a IN (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u)",
      ]) {
        const sql = translateTsql(q, "postgres").sql;
        await pool.query(`SET search_path=${sch}; ${sql}`);
      }
      expect(true).toBe(true);
    } finally {
      await pool.query(`DROP SCHEMA ${sch} CASCADE`);
      await pool.end();
    }
  });
});
