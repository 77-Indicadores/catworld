// @vitest-environment node
/** DELETE em lotes contra Postgres real. Só com CW_TEST_PG_URL (banco DESCARTÁVEL; NUNCA produção). */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});
const d = process.env.CW_TEST_PG_URL ? describe : describe.skip;
const TAG = `bd-${Date.now().toString(36)}`;

d("deleteInBatches (Postgres real)", () => {
  afterAll(async () => { const { prisma } = await import("@/server/db"); await prisma.$executeRawUnsafe(`DELETE FROM cw_audit_events WHERE event_type = $1`, TAG); });

  it("apaga só o que casa, em lotes, e devolve o total exato", async () => {
    const { prisma } = await import("@/server/db");
    await prisma.$executeRawUnsafe(`INSERT INTO cw_audit_events (id, event_type, resource_type, success, created_at) SELECT gen_random_uuid(), $1, 'x', true, now() - interval '60 days' FROM generate_series(1, 2500)`, TAG);
    await prisma.$executeRawUnsafe(`INSERT INTO cw_audit_events (id, event_type, resource_type, success, created_at) SELECT gen_random_uuid(), $1, 'x', true, now() FROM generate_series(1, 300)`, TAG);
    const { deleteInBatches } = await import("./batched-delete");
    const n = await deleteInBatches("cw_audit_events", `event_type = $1 AND created_at < NOW() - interval '30 days'`, [TAG], 1000);
    expect(n).toBe(2500);                                     // 3 lotes: 1000 + 1000 + 500
    const left = (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM cw_audit_events WHERE event_type = $1`, TAG))[0]!.n;
    expect(Number(left)).toBe(300);                            // os recentes ficam
  });
  it("nada a apagar: 0", async () => {
    const { deleteInBatches } = await import("./batched-delete");
    expect(await deleteInBatches("cw_audit_events", `event_type = $1 AND created_at < NOW() - interval '30 days'`, [`${TAG}-nada`], 1000)).toBe(0);
  });
});
