const forbidden = new Set([
  // comandos que escrevem / mudam estado
  "alter", "create", "delete", "deny", "drop", "exec", "execute", "grant", "insert", "merge", "reconfigure", "revoke", "truncate", "update", "use",
  // SELECT ... INTO cria tabela
  "into",
  // SQL Server: leitura externa e espera (negacao de servico)
  "openrowset", "openquery", "opendatasource", "waitfor",
  // Postgres: arquivos do servidor, sessoes, sequencias, configuracao, dblink, espera
  "pg_read_file", "pg_read_binary_file", "pg_stat_file", "pg_sleep", "pg_sleep_for", "pg_sleep_until",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_switch_wal", "pg_create_restore_point",
  "set_config", "nextval", "setval", "lo_import", "lo_export", "lo_create", "lo_unlink", "lo_put", "lo_from_bytea",
]);
// Prefixos de familias de funcoes (pg_ls_dir, pg_ls_logdir…, pg_advisory_lock…, dblink, dblink_exec…)
const forbiddenPrefixes = ["pg_ls_", "pg_advisory", "dblink"];

// Defesa em PROFUNDIDADE: esta lista nao substitui o banco. No Postgres a consulta roda em
// transacao READ ONLY e no papel do ator (storage/pg-roles.ts); no SQL Server, no principal com grants.

export type SqlValidation = { safe: true; statement: string } | { safe: false; reason: string };

export function validateReadOnlySql(input: string): SqlValidation {
  if (!input.trim()) return { safe: false, reason: "Consulta vazia" };
  if (input.length > 50_000) return { safe: false, reason: "Consulta excede 50.000 caracteres" };
  const cleaned = stripCommentsAndStrings(input);
  const statements = cleaned.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) return { safe: false, reason: "Apenas uma instrução SQL é permitida" };
  const tokens = statements[0].toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  if (!tokens.length || !["select", "with"].includes(tokens[0]!)) return { safe: false, reason: "Somente SELECT ou WITH são permitidos" };
  const blocked = tokens.find((token) => forbidden.has(token) || forbiddenPrefixes.some((p) => token.startsWith(p)));
  if (blocked) return { safe: false, reason: `Comando bloqueado: ${blocked.toUpperCase()}` };
  return { safe: true, statement: input.trim().replace(/;+\s*$/, "") };
}

function stripCommentsAndStrings(sql: string): string {
  let out = "", i = 0, state: "normal" | "single" | "double" | "line" | "block" = "normal";
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (state === "normal") {
      if (c === "'" ) { state = "single"; out += " "; }
      else if (c === '"') { state = "double"; out += " "; }
      else if (c === "-" && n === "-") { state = "line"; out += "  "; i++; }
      else if (c === "/" && n === "*") { state = "block"; out += "  "; i++; }
      else out += c;
    } else if (state === "single") {
      if (c === "'" && n === "'") { out += "  "; i++; }
      else if (c === "'") { state = "normal"; out += " "; }
      else out += c === "\n" ? "\n" : " ";
    } else if (state === "double") {
      if (c === '"') state = "normal";
      out += c === "\n" ? "\n" : " ";
    } else if (state === "line") {
      if (c === "\n") { state = "normal"; out += "\n"; } else out += " ";
    } else {
      if (c === "*" && n === "/") { state = "normal"; out += "  "; i++; } else out += c === "\n" ? "\n" : " ";
    }
    i++;
  }
  return out;
}