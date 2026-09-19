/** Esconde credenciais de uma string de conexão para exibição: `password=...` e o `usuario:senha@` de URLs. */
export function maskConnectionString(url: string | null): string {
  if (!url) return "—";
  return url
    .replace(/(password|pwd)\s*=\s*[^;&\s]+/gi, "$1=••••••••")
    .replace(/(:\/\/[^:/@\s]+):[^@/\s]+@/, "$1:••••••••@");
}
