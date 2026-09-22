/**
 * Retomar a liderança do supervisor depois de a conexão do lock cair.
 *
 * Antes: a queda da conexão dedicada do advisory lock (pooler, NAT/balanceador com idle timeout, restart do banco) fazia o supervisor
 * dar `process.exit(1)`; ele é o PID 1 do contêiner, então o contêiner reiniciava e MATAVA os workers no meio de imports de 20-48 min
 * (docs/estudo-confiabilidade-dados.md, hipótese da causa dos WORKER_CRASHED). O lock de sessão é liberado pelo Postgres quando a
 * conexão cai, e ninguém mais o pegou se não houver outro supervisor: dá para simplesmente pegá-lo de novo, sem derrubar nada.
 * Só sai se outro supervisor JÁ assumiu (aí manter os workers criaria dois supervisores).
 */
export async function retakeLeadership<T>(
  acquire: () => Promise<T | null>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; baseDelayMs?: number; log?: (m: string) => void } = {},
): Promise<T | null> {
  const attempts = opts.attempts ?? 6;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseDelayMs ?? 1000;
  for (let i = 1; i <= attempts; i++) {
    try {
      const got = await acquire();
      if (got) return got;
      // null = outro supervisor JÁ tem o lock: não adianta insistir, a liderança é dele
      opts.log?.("outro supervisor assumiu a liderança");
      return null;
    } catch (e) {
      // erro de conexão (o banco ainda pode estar voltando): tenta de novo com espera crescente
      opts.log?.(`tentativa ${i}/${attempts} de retomar a liderança falhou: ${e instanceof Error ? e.message : String(e)}`);
      if (i < attempts) await sleep(base * i);
    }
  }
  return null;
}
