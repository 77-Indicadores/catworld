import { hostname } from "node:os";
import { prisma } from "@/server/db";
import { assertNotCancelled } from "./job-cancel";

// Trava de import por tabela: lock por linha em cw_import_locks (nunca uma transação Postgres de vida longa — o trabalho protegido é
// externo, ex.: SQL Server, e pode legitimamente levar minutos).
//
// Modelo de LEASE (docs/estudo-confiabilidade-dados.md, MOT-02/MOT-10). Antes a trava tinha TTL fixo de 30 min sem renovação:
//   (a) um import legítimo mais longo que 30 min perdia a trava com o dono VIVO, outro import entrava na mesma tabela e um apagava
//       em silêncio o trabalho do outro;
//   (b) um dono MORTO (deploy, queda) segurava a trava por 30 min, com a retentativa parada num slot do worker.
// Agora o dono renova a cada RENEW_MS um lease curto (LEASE_MS): dono vivo nunca perde a trava e dono morto bloqueia no máximo
// LEASE_MS. Quem perdeu o lease (renovação falhou) fica sabendo por `lease.assert()` e DEVE abortar antes de publicar.

export const LEASE_MS = 120_000;
export const RENEW_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
const POLL_MS = 2_000;

export class LeaseLostError extends Error {
  constructor(key: string) {
    super(`Perdi o lease do import de "${key}" (o lock expirou ou foi retomado por outro processo); abortando antes de publicar para não sobrescrever o trabalho dele.`);
    this.name = "LeaseLostError";
  }
}

export type Lease = {
  readonly key: string;
  /** true depois que a renovação falhou ou o lease expirou */
  readonly lost: boolean;
  /** lança LeaseLostError se o lease se perdeu; chamar antes do swap e a cada N lotes */
  assert(): void;
};

export type LockOptions = { leaseMs?: number; renewMs?: number; pollMs?: number };

function holderId(): string {
  return `${hostname()}:${process.pid}:${Date.now()}`;
}

async function tryAcquire(key: string, holder: string, leaseMs: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ lock_key: string }[]>`
    INSERT INTO cw_import_locks (lock_key, locked_at, locked_by, expires_at)
    VALUES (${key}, now(), ${holder}, now() + (${leaseMs}::text || ' milliseconds')::interval)
    ON CONFLICT (lock_key) DO UPDATE
      SET locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by, expires_at = EXCLUDED.expires_at
      WHERE cw_import_locks.expires_at < now()
    RETURNING lock_key
  `;
  return rows.length > 0;
}

async function renew(key: string, holder: string, leaseMs: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ lock_key: string }[]>`
    UPDATE cw_import_locks SET expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval
    WHERE lock_key = ${key} AND locked_by = ${holder}
    RETURNING lock_key
  `;
  return rows.length > 0;
}

async function release(key: string, holder: string): Promise<void> {
  // Só apaga se o holder ainda bater — evita que um release atrasado apague um lock já retomado por outro processo.
  await prisma.$executeRaw`DELETE FROM cw_import_locks WHERE lock_key = ${key} AND locked_by = ${holder}`;
}

/** Locks que ESTE processo detém agora: liberados explicitamente quando o worker recebe SIGTERM (ver releaseAllImportLocks). */
const held = new Map<string, string>();

/** Libera todos os locks deste processo (SIGTERM/deploy): o próximo dono não espera o lease expirar. */
export async function releaseAllImportLocks(): Promise<number> {
  const entries = [...held.entries()];
  held.clear();
  await Promise.all(entries.map(([key, holder]) => release(key, holder).catch(() => undefined)));
  return entries.length;
}

/**
 * Serializa `fn` por `key`. Espera até `maxWaitMs` por um lock já detido (o job tem retry próprio se não conseguir). Enquanto `fn`
 * roda, o lease é renovado; `fn` recebe o `Lease` para checar `assert()` antes de publicar.
 */
export async function withImportLock<T>(
  key: string,
  fn: (lease: Lease) => Promise<T>,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  opts: LockOptions = {},
): Promise<T> {
  const leaseMs = opts.leaseMs ?? LEASE_MS, renewMs = opts.renewMs ?? RENEW_MS, pollMs = opts.pollMs ?? POLL_MS;
  const holder = holderId();
  const deadline = Date.now() + maxWaitMs;

  while (!(await tryAcquire(key, holder, leaseMs))) {
    if (Date.now() >= deadline) {
      throw new Error(`Não foi possível obter o lock de import para "${key}" — outro import está em andamento nela.`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  held.set(key, holder);

  let lost = false;
  let lastOkAt = Date.now();
  const timer = setInterval(() => {
    void renew(key, holder, leaseMs).then(
      (ok) => { if (ok) lastOkAt = Date.now(); else lost = true; },
      // erro transitório de banco: só considera perdido se o lease local já venceu sem nenhuma renovação bem-sucedida
      () => { if (Date.now() - lastOkAt >= leaseMs) lost = true; },
    );
  }, renewMs);
  timer.unref?.();

  const lease: Lease = {
    key,
    get lost() { return lost || Date.now() - lastOkAt >= leaseMs; },
    assert() {
      if (lease.lost) throw new LeaseLostError(key);
      assertNotCancelled(); // job cancelado enquanto importava: aborta antes de publicar
    },
  };

  try {
    return await fn(lease);
  } finally {
    clearInterval(timer);
    held.delete(key);
    await release(key, holder);
  }
}
