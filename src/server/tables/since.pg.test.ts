/** SQL do `since` executado em Postgres real. So roda com CW_TEST_PG_URL (descartavel — NUNCA producao). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { decodeCursor, pgRemovedSql, pgRowsPageSql, shapeRowsPage, settleFirstPage, type PageRow } from "./since";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("since (executando)", () => {
  const pool = new Pool({ connectionString: url });
  const q = (sql: string) => pool.query(sql).then((r) => r.rows as PageRow[]);
  const base = { qTarget: '"sn"."evt"', colList: '"id", "nome"', qSynced: '"cw_synced_at"', qDeleted: '"cw_deleted_at"', qKey: '"id"', keySqlType: "BIGINT", sinceLit: "'2000-01-01 00:00:00'", cursor: null, limit: 500 };

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS sn CASCADE; CREATE SCHEMA sn;
      CREATE TABLE sn.evt (id bigint, nome text, cw_synced_at timestamp NOT NULL, cw_deleted_at timestamp);
      INSERT INTO sn.evt SELECT g, 'n'||g, timestamp '2026-09-19 10:00:00.123456', NULL FROM generate_series(1, 3000) g;
      INSERT INTO sn.evt SELECT 5000+g, 'p'||g, timestamp '2026-09-19 11:00:00', NULL FROM generate_series(1, 700) g;
      INSERT INTO sn.evt SELECT 9000+g, 'a'||g, timestamp '2026-09-19 09:00:00', NULL FROM generate_series(1, 5) g;
      INSERT INTO sn.evt SELECT 8000+g, 'x'||g, timestamp '2026-09-19 08:00:00', timestamp '2026-09-19 10:30:00' FROM generate_series(1, 4) g;
      CREATE TABLE sn.textkey (k text, cw_synced_at timestamp NOT NULL, cw_deleted_at timestamp);
      INSERT INTO sn.textkey SELECT 'k' || lpad(g::text, 4, '0'), timestamp '2026-09-19 10:00:00', NULL FROM generate_series(1, 1200) g;
      CREATE TABLE sn.nokey (v int, cw_synced_at timestamp NOT NULL, cw_deleted_at timestamp);
      INSERT INTO sn.nokey SELECT g, timestamp '2026-09-19 10:00:00', NULL FROM generate_series(1, 1800) g;`);
  });
  afterAll(async () => { await pool.query("DROP SCHEMA IF EXISTS sn CASCADE"); await pool.end(); });

  it("cursor: percorre as 3705 linhas alteradas em paginas de 500, cada uma UMA vez, em ordem (carimbo, chave)", async () => {
    let cursor: ReturnType<typeof decodeCursor> = null;
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const raw = await q(pgRowsPageSql({ ...base, cursor }));
      const s = shapeRowsPage(raw, 500, new Date(0));
      ids.push(...s.page.map((r) => Number(r.id)));
      if (!s.hasMore) break;
      cursor = decodeCursor(s.nextCursor!);
    }
    expect(ids).toHaveLength(3705);
    expect(new Set(ids).size).toBe(3705);
    // ordem: lote das 9h (9001..9005), depois 1..3000 (mesmo carimbo, por chave), depois 5001..5700 (11h)
    expect(ids.slice(0, 5)).toEqual([9001, 9002, 9003, 9004, 9005]);
    expect(ids.slice(5, 8)).toEqual([1, 2, 3]);
    expect(ids.at(-1)).toBe(5700);
  });

  it("sem cursor: a 1a pagina traz o grupo das 10h INTEIRO e o nextSince passa por ele", async () => {
    const lit = "'2026-09-19 09:30:00'";
    const raw = await q(pgRowsPageSql({ ...base, sinceLit: lit, limit: 1000 }));
    const s = await settleFirstPage(raw, 1000, new Date("2026-09-19T09:30:00Z"), () => q(pgRowsPageSql({ ...base, sinceLit: lit, limit: 50_000 })));
    expect(s.page).toHaveLength(3000);
    expect(s.hasMore).toBe(true); // ainda ha as das 11h
    // seguir o carimbo exato do grupo entrega as restantes sem repetir o grupo
    const next = await q(pgRowsPageSql({ ...base, sinceLit: `'${s.page.at(-1)!.__cw_synced_txt}'`, limit: 1000 }));
    expect(next).toHaveLength(700);
  });

  it("chave TEXTO: cursor funciona", async () => {
    let cursor: ReturnType<typeof decodeCursor> = null;
    const keys: string[] = [];
    const t = { ...base, qTarget: '"sn"."textkey"', colList: '"k"', qKey: '"k"', keySqlType: "NVARCHAR(MAX)", limit: 400 };
    for (let i = 0; i < 10; i++) {
      const s = shapeRowsPage(await q(pgRowsPageSql({ ...t, cursor })), 400, new Date(0));
      keys.push(...s.page.map((r) => String(r.k)));
      if (!s.hasMore) break;
      cursor = decodeCursor(s.nextCursor!);
    }
    expect(keys).toHaveLength(1200);
    expect(keys[0]).toBe("k0001");
    expect(keys.at(-1)).toBe("k1200");
  });

  it("SEM chave (fullSwap): grupo empatado inteiro numa chamada; nada perdido", async () => {
    const t = { ...base, qTarget: '"sn"."nokey"', colList: '"v"', qKey: null, limit: 500 };
    const raw = await q(pgRowsPageSql(t));
    const s = await settleFirstPage(raw, 500, new Date(0), () => q(pgRowsPageSql({ ...t, limit: 50_000 })));
    expect(s.page).toHaveLength(1800);
    expect(s.hasMore).toBe(false);
  });

  it("exclusoes: todas, sem o teto do limit, ordenadas", async () => {
    const r = await q(pgRemovedSql({ qTarget: base.qTarget, qDeleted: base.qDeleted, qKey: base.qKey, sinceLit: base.sinceLit }));
    expect(r.map((x) => Number((x as unknown as { k: string }).k))).toEqual([8001, 8002, 8003, 8004]);
  });
});
