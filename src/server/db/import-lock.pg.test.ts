// @vitest-environment node
/**
 * Lease do lock de import contra Postgres real (cw_import_locks). Só roda com CW_TEST_PG_URL (banco DESCARTÁVEL com o schema do
 * Catworld; NUNCA produção). Usa chaves únicas por execução.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

const d = process.env.CW_TEST_PG_URL ? describe : describe.skip;
const KEY = () => `lease-test:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("withImportLock (lease)", () => {
  afterAll(async () => { const { prisma } = await import("@/server/db"); await prisma.$executeRawUnsafe(`DELETE FROM cw_import_locks WHERE lock_key LIKE 'lease-test:%'`); });

  it("serializa: o segundo espera o primeiro terminar", async () => {
    const { withImportLock } = await import("./import-lock");
    const k = KEY(); const order: string[] = [];
    let aStarted!: () => void; const started = new Promise<void>((r) => { aStarted = r; });
    const a = withImportLock(k, async () => { order.push("a-start"); aStarted(); await sleep(400); order.push("a-end"); }, 5000, { pollMs: 50 });
    await started;
    const b = withImportLock(k, async () => { order.push("b-start"); order.push("b-end"); }, 5000, { pollMs: 50 });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("dono VIVO nunca perde o lock: o lease é renovado além do TTL (o bug do TTL fixo de 30 min)", async () => {
    const { withImportLock } = await import("./import-lock");
    const k = KEY();
    const opts = { leaseMs: 400, renewMs: 100, pollMs: 50 };
    let intruded = false;
    await withImportLock(k, async (lease) => {
      // outro importador tenta entrar por 1,2 s (3x o lease) e não pode
      const other = withImportLock(k, async () => { intruded = true; }, 1200, opts).catch(() => "sem-lock");
      await sleep(1300);
      lease.assert();
      expect(await other).toBe("sem-lock");
    }, 5000, opts);
    expect(intruded).toBe(false);
  });

  it("dono MORTO bloqueia no máximo o lease (e não 30 min): o próximo assume", async () => {
    const { withImportLock } = await import("./import-lock");
    const { prisma } = await import("@/server/db");
    const k = KEY();
    // simula um processo que morreu segurando a trava com lease curto (nunca renova)
    await prisma.$executeRawUnsafe(`INSERT INTO cw_import_locks (lock_key, locked_at, locked_by, expires_at) VALUES ($1, now(), 'morto:1:0', now() + interval '600 milliseconds')`, k);
    const t0 = Date.now();
    await withImportLock(k, async () => undefined, 5000, { leaseMs: 400, renewMs: 100, pollMs: 50 });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(3000);
  });

  it("lease perdido (outro processo retomou): assert() lança e o release não apaga o lock do outro", async () => {
    const { withImportLock, LeaseLostError } = await import("./import-lock");
    const { prisma } = await import("@/server/db");
    const k = KEY();
    let caught: unknown;
    await withImportLock(k, async (lease) => {
      await prisma.$executeRawUnsafe(`UPDATE cw_import_locks SET locked_by = 'intruso:9:9', expires_at = now() + interval '1 minute' WHERE lock_key = $1`, k);
      await sleep(250);                      // a próxima renovação percebe que não é mais o dono
      try { lease.assert(); } catch (e) { caught = e; }
    }, 5000, { leaseMs: 5000, renewMs: 100, pollMs: 50 });
    expect(caught).toBeInstanceOf(LeaseLostError);
    const row = (await prisma.$queryRawUnsafe<{ locked_by: string }[]>(`SELECT locked_by FROM cw_import_locks WHERE lock_key = $1`, k))[0];
    expect(row?.locked_by).toBe("intruso:9:9");   // o lock do outro continua lá
  });

  it("releaseAllImportLocks (SIGTERM): libera na hora, sem esperar o lease", async () => {
    const { withImportLock, releaseAllImportLocks } = await import("./import-lock");
    const k = KEY();
    let released = 0;
    const holding = withImportLock(k, async () => { released = await releaseAllImportLocks(); await sleep(100); }, 5000, { leaseMs: 60_000, renewMs: 5000, pollMs: 50 });
    await holding;
    expect(released).toBeGreaterThanOrEqual(1);
    const t0 = Date.now();
    await withImportLock(k, async () => undefined, 2000, { leaseMs: 60_000, pollMs: 50 });   // entra sem esperar 60 s
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("erro dentro de fn: o lock é liberado", async () => {
    const { withImportLock } = await import("./import-lock");
    const k = KEY();
    await expect(withImportLock(k, async () => { throw new Error("boom"); }, 2000, { pollMs: 50 })).rejects.toThrow("boom");
    await withImportLock(k, async () => undefined, 1000, { pollMs: 50 });
  });
});
