"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Eye, LifeBuoy, ShieldCheck, Undo2 } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Time } from "@/components/ui/time";

type Mode = "off" | "shadow" | "fallback" | "strict";

type Stats = {
  since: string;
  translated: Record<string, number>;
  byKind: Record<string, number>;
  top: { kind: string; path: string; hash: string; shape: string; count: number; lastAt: string; message?: string }[];
};

const KIND_LABEL: Record<string, string> = {
  "shadow-diff": "traduziria diferente",
  "shadow-reject": "motor novo rejeitaria",
  "fallback-reject": "motor novo rejeitou → usou o antigo",
  "fallback-exec": "SQL novo falhou no banco → usou o antigo",
};

const MODES: { id: Mode; label: string; icon: React.ElementType; description: string; detail: string }[] = [
  {
    id: "off",
    label: "Desligado",
    icon: Undo2,
    description: "Comportamento anterior ao contrato.",
    detail: "Nenhuma tradução nova. Storage Postgres usa o tradutor antigo e o live envia o SQL como está.",
  },
  {
    id: "shadow",
    label: "Observar",
    icon: Eye,
    description: "Responde como antes e registra o que mudaria.",
    detail: "Nada muda para quem já usa. O motor novo roda em paralelo e loga (tag sql-contract) o que ele rejeitaria ou traduziria diferente, sem gravar valores.",
  },
  {
    id: "fallback",
    label: "Fallback (padrão)",
    icon: LifeBuoy,
    description: "Motor novo, com rede de segurança do antigo.",
    detail: "Usa o motor novo. Se ele rejeitar a consulta (ex.: ::, ILIKE) ou o banco falhar ao executá-la, refaz pelo caminho antigo; se o antigo também falhar, devolve o erro antigo. Nada que funcionava deixa de funcionar, e T-SQL que antes falhava passa a funcionar.",
  },
  {
    id: "strict",
    label: "Estrito",
    icon: ShieldCheck,
    description: "T-SQL único, traduzido por backend.",
    detail: "Usa o motor novo. Construção fora do contrato falha com UNSUPPORTED_CONSTRUCT, incluindo SQL em sintaxe Postgres (::, ILIKE).",
  },
];

export default function SqlContractSettingsPage() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [saved, setSaved] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pgIsolation, setPgIsolation] = useState<string | null>(null);
  const [resultFormat, setResultFormat] = useState<"legacy" | "normalized">("legacy");
  const [fmtSaving, setFmtSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/sql-contract")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error.message ?? "Falha ao carregar");
        else { setMode(j.data.mode); setSaved(j.data.mode); setStats(j.data.stats ?? null); setPgIsolation(j.data.pgIsolation ?? null); setResultFormat(j.data.resultFormat === "normalized" ? "normalized" : "legacy"); }
      })
      .catch(() => setError("Falha ao carregar"));
  }, []);

  async function saveFormat(next: "legacy" | "normalized") {
    if (next === resultFormat) return;
    setFmtSaving(true); setError("");
    try {
      const r = await fetch("/api/v1/settings/sql-contract", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultFormat: next }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? "Falha ao salvar");
      setResultFormat(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setFmtSaving(false);
    }
  }

  async function save() {
    if (!mode) return;
    setSaving(true); setError(""); setOk(false);
    try {
      const r = await fetch("/api/v1/settings/sql-contract", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? "Falha ao salvar");
      setSaved(mode); setOk(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  if (!mode && !error) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Contrato de SQL" description="Como o Catworld valida e traduz o SQL escrito pelos usuários." />
        <div className="rounded-box border border-base-300 bg-base-100 p-10 text-center"><span className="loading loading-spinner" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Configurações" title="Contrato de SQL" description="Como o Catworld valida e traduz o SQL escrito pelos usuários." />
      {ok && (
        <div className="alert alert-success alert-soft">
          <CheckCircle2 className="size-4" /> Modo salvo. Vale em até 30 segundos em todas as instâncias.
        </div>
      )}
      {error && <div className="alert alert-error alert-soft">{error}</div>}

      <Panel>
        <div className="p-5 space-y-4">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Modo</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setMode(m.id); setOk(false); }}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all ${
                    active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-base-300 hover:border-base-content/30"
                  }`}
                >
                  <Icon className="size-5" />
                  <span className="font-semibold text-sm mt-1">{m.label}</span>
                  <span className="text-xs text-base-content/65 leading-snug">{m.description}</span>
                </button>
              );
            })}
          </div>
          {mode && <p className="text-xs text-base-content/65 leading-relaxed">{MODES.find((m) => m.id === mode)?.detail}</p>}
          {mode === "strict" && saved !== "strict" && (
            <div className="alert alert-warning alert-soft text-sm">
              O modo estrito pode rejeitar consultas que hoje funcionam. Prefira o Fallback; ative o Estrito depois de revisar os logs (tag sql-contract).
            </div>
          )}
          <div className="flex justify-end">
            <button className="btn btn-primary btn-sm" disabled={saving || mode === saved} onClick={save}>
              {saving ? <span className="loading loading-spinner loading-xs" /> : "Salvar"}
            </button>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="p-5 space-y-3">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Uso do contrato</h2>
          <p className="text-xs text-base-content/65">
            Contadores desta instância desde {stats ? <Time iso={stats.since} /> : "—"} (zeram ao reiniciar). Guardam só o
            formato da consulta, sem valores.
          </p>
          {stats && Object.keys(stats.translated).length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs" data-testid="translated">
              {Object.entries(stats.translated).map(([path, n]) => (
                <span key={path} className="badge badge-ghost">{path}: {n} consulta(s)</span>
              ))}
            </div>
          )}
          {stats && stats.top.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table table-xs">
                <thead><tr><th>Ocorrências</th><th>O que aconteceu</th><th>Caminho</th><th>Consulta (formato)</th></tr></thead>
                <tbody>
                  {stats.top.map((t) => (
                    <tr key={`${t.kind}|${t.path}|${t.hash}`}>
                      <td className="font-mono">{t.count}</td>
                      <td>{KIND_LABEL[t.kind] ?? t.kind}{t.message ? <div className="text-base-content/65">{t.message}</div> : null}</td>
                      <td className="font-mono">{t.path}</td>
                      <td className="font-mono max-w-md truncate" title={t.shape}>{t.shape}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-base-content/65">Nenhum caso registrado: nada foi rejeitado nem caiu no caminho antigo.</p>
          )}
        </div>
      </Panel>

      <Panel>
        <div className="p-5 space-y-2 text-sm text-base-content/70">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Isolamento no storage Postgres</h2>
          <p>
            Estado: <strong>{pgIsolation === "off" ? "desligado (consultas de não-admin NÃO são isoladas por schema)" : "ativo"}</strong>.
            Cada ator consulta com um papel de banco que só enxerga os schemas dos seus datasets, em transação somente leitura.
            Exige que a conta do storage tenha <code>CREATEROLE</code>.
          </p>
        </div>
      </Panel>

      <Panel>
        <div className="p-5 space-y-2 text-sm text-base-content/70">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Formato do resultado</h2>
          <p>Formato padrão para requisições que <strong>não</strong> enviam <code>normalize</code>:</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Formato padrão do resultado">
            <button
              type="button" disabled={fmtSaving} onClick={() => saveFormat("legacy")}
              className={`btn btn-sm ${resultFormat === "legacy" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            >
              Legado (deprecado)
            </button>
            <button
              type="button" disabled={fmtSaving} onClick={() => saveFormat("normalized")}
              className={`btn btn-sm ${resultFormat === "normalized" ? "btn-primary" : "btn-ghost border border-base-300"}`}
            >
              Normalizado (recomendado)
            </button>
          </div>
          <p className="text-xs text-base-content/65">
            Legado: tipos como o driver entrega (varia por backend); as respostas avisam em <code>meta.warnings</code>. Normalizado: datas
            ISO, decimal e bigint como texto. Quem envia <code>normalize</code> explicitamente não é afetado.
          </p>
          <p>
            A normalização de tipos (datas ISO, bigint e decimal como texto) é escolhida por requisição com
            <code className="mx-1">&quot;normalize&quot;: true</code>e não depende deste modo. O CSV de export aceita
            <code className="mx-1">dateFormat=iso</code>para datas em ISO-8601.
          </p>
        </div>
      </Panel>
    </div>
  );
}
