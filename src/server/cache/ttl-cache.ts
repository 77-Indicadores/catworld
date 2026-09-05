/**
 * Cache em memória com TTL + limite de tamanho (LRU simples via ordem do Map)
 * e varredura periódica ativa de entradas expiradas.
 *
 * Por que existe: caches "TTL preguiçoso" (só checam expiração ao ler a MESMA
 * chave de novo) crescem sem limite num processo de vida longa — chaves que
 * nunca voltam a ser lidas ficam esquecidas no Map para sempre. Isso já causou
 * OOM em produção no endpoint OData (datasetCache/tokenCache/countCache).
 * Esta classe resolve isso combinando:
 *   1. Eviction por tamanho máximo (LRU) — nunca ultrapassa maxSize entradas.
 *   2. Varredura periódica — remove entradas expiradas mesmo sem serem lidas.
 */
export class TtlCache<K, V> {
  private store = new Map<K, { value: V; expiresAt: number }>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxSize: number,
    sweepIntervalMs = 60_000,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  get(key: K): V | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Re-insere para atualizar posição de eviction (LRU via ordem de inserção do Map)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    this.store.delete(key); // evita duplicar posição se a chave já existir
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Remove todas as entradas cuja chave satisfaz o predicado (ex: invalidação por prefixo). */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
  }
}
