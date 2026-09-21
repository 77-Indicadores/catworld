// @vitest-environment node
/**
 * MssqlStorageConnection contra SQL Server REAL (CW_TEST_MSSQL_URL, descartavel): bulkInsert exato (B1), timestamps (M6), indice cw_synced_at (H2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MssqlStorageConnection } from "./mssql-storage";
import { CW_SYNCED_AT } from "./connection";

const url = process.env.CW_TEST_MSSQL_URL;
const d = url ? describe : describe.skip;
const SCHEMA = `bi_${Date.now().toString(36)}`;

d("MssqlStorageConnection (SQL Server real)", () => {
  let st: MssqlStorageConnection;
  beforeAll(async () => {
    st = new MssqlStorageConnection(`bi-${randomUUID()}`, url!);
    await st.createSchemaIfNotExists(SCHEMA);
  });
  afterAll(async () => {
    try { await st.dropSchemaIfExists(SCHEMA); } catch { /* best-effort */ }
    try { await (await st.rawPool()).close(); } catch { /* */ }
  });

  it("B1: DECIMAL(20,6), DECIMAL(38,10), DECIMAL(18,4) e BIGINT > 2^53 entram exatos", async () => {
    const cols = [
      { name: "a", sqlType: "DECIMAL(20,6)", nullable: true },
      { name: "b", sqlType: "DECIMAL(38,10)", nullable: true },
      { name: "c", sqlType: "DECIMAL(18,4)", nullable: true },
      { name: "d", sqlType: "BIGINT", nullable: true },
      { name: "e", sqlType: "DECIMAL(12,2)", nullable: true },
    ];
    await st.createTable(SCHEMA, "t_b1", cols);
    await st.bulkInsert(SCHEMA, "t_b1", cols, [
      ["0.000123", "1234567890123456789012345678.1234567891", "12345678901234.5678", "9007199254740993", "10.25"],
      ["-99999999999999.999999", "-0.0000000001", "-0.0001", "-9223372036854775807", "-1.5"],
      [null, null, null, null, null],
    ]);
    const r = await st.query<Record<string, string | null>>(
      `SELECT CAST(a AS NVARCHAR(50)) a, CAST(b AS NVARCHAR(60)) b, CAST(c AS NVARCHAR(40)) c, CAST(d AS NVARCHAR(30)) d, CAST(e AS NVARCHAR(30)) e FROM [${SCHEMA}].[t_b1] ORDER BY d`,
    );
    const byD = Object.fromEntries(r.map((x) => [String(x.d), x]));
    expect(byD["9007199254740993"]).toMatchObject({ a: "0.000123", b: "1234567890123456789012345678.1234567891", c: "12345678901234.5678", e: "10.25" });
    expect(byD["-9223372036854775807"]).toMatchObject({ a: "-99999999999999.999999", b: "-0.0000000001", c: "-0.0001", e: "-1.50" });
    expect(r.some((x) => x.a === null && x.d === null)).toBe(true);
  });

  it("B1: valor que nao cabe no tipo FALHA (nunca arredonda em silencio)", async () => {
    const cols = [{ name: "a", sqlType: "DECIMAL(20,6)", nullable: true }];
    await st.createTable(SCHEMA, "t_b1_over", cols);
    await expect(st.bulkInsert(SCHEMA, "t_b1_over", cols, [["123456789012345678901.5"]])).rejects.toThrow();
  });

  it("M6: DATETIME2 canonico sem Z entra como UTC com microssegundos, em qualquer TZ do processo", async () => {
    const cols = [
      { name: "id", sqlType: "BIGINT", nullable: true },
      { name: "ts", sqlType: "DATETIME2", nullable: true },
      { name: "dt", sqlType: "DATE", nullable: true },
    ];
    await st.createTable(SCHEMA, "t_m6", cols);
    await st.bulkInsert(SCHEMA, "t_m6", cols, [[1, "2024-03-10 12:34:56.123456", "2024-03-10"]]);
    const r = await st.query<{ ts: string; dt: string }>(`SELECT CONVERT(NVARCHAR(40), ts, 121) ts, CONVERT(NVARCHAR(20), dt, 23) dt FROM [${SCHEMA}].[t_m6]`);
    expect(r[0]!.ts).toBe("2024-03-10 12:34:56.1234560");
    expect(r[0]!.dt).toBe("2024-03-10");
  });

  it("H2: cada swap deixa exatamente um indice em cw_synced_at (fullSwap e merge, varias rodadas)", async () => {
    const cols = [{ name: "id", sqlType: "BIGINT", nullable: false }, { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true }];
    const idx = async (t: string) => (await st.query<{ n: number }>(
      `SELECT COUNT(*) n FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
       JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
       WHERE i.object_id=OBJECT_ID(N'[${SCHEMA}].[${t}]') AND c.name=N'${CW_SYNCED_AT}' AND ic.key_ordinal=1`))[0]!.n;
    for (let i = 0; i < 4; i++) {
      await st.createTable(SCHEMA, "stg_full", cols);
      await st.bulkInsert(SCHEMA, "stg_full", cols, [[1, "a"], [2, "b"]]);
      await st.atomicSwap(SCHEMA, "stg_full", "t_full", cols, { targetExists: i > 0 });
      expect(await idx("t_full")).toBe(1);
    }
    for (let i = 0; i < 4; i++) {
      await st.createTable(SCHEMA, "stg_mrg", cols);
      await st.bulkInsert(SCHEMA, "stg_mrg", cols, [[1, "a"], [i + 10, "b"]]);
      await st.atomicSwap(SCHEMA, "stg_mrg", "t_mrg", cols, { targetExists: i > 0, keyColumn: "id", mergedName: "mgd_x" });
      expect(await idx("t_mrg")).toBe(1);
    }
  });
});
