/**
 * Fixa o fuso do processo em UTC (FON-03). Sem isso, qualquer conversao que passe por `Date` (timestamps do storage, marca
 * d'agua, datas do driver do SQL Server) muda de valor conforme o `TZ` da maquina. Chamar o quanto antes na entrada do
 * worker e do servidor web (antes de qualquer conexao ser aberta). Idempotente.
 *
 * Retorna o `TZ` que estava em vigor antes (undefined = nao definido) para permitir log/diagnostico.
 */
export function ensureUtcTimezone(): string | undefined {
  const before = process.env.TZ;
  if (before !== "UTC") process.env.TZ = "UTC";
  return before;
}
