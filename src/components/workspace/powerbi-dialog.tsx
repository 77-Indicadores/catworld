"use client";
import { useState } from "react";
import { Check, Copy, ExternalLink, BarChart2, X, Monitor, Cloud } from "lucide-react";

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-base-content/60">{label}</p>
      <button
        onClick={copy}
        className={`flex w-full items-center justify-between gap-3 rounded-lg border border-base-300 bg-base-200 px-3 py-2 text-left hover:bg-base-300 ${mono ? "font-mono text-xs" : "text-xs"}`}
      >
        <span className="truncate">{value}</span>
        {copied ? <Check size={13} className="shrink-0 text-success" /> : <Copy size={13} className="shrink-0 text-base-content/40" />}
      </button>
    </div>
  );
}

type Tab = "desktop" | "service";

export function PowerBIDialog({ projectSlug, datasetSlug, datasetName, publicOrigin }: { projectSlug: string; datasetSlug: string; datasetName: string; publicOrigin: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("desktop");
  const [token, setToken] = useState("");

  const baseUrl = `${publicOrigin}/api/odata/${projectSlug}/${datasetSlug}`;
  const serviceUrl = token ? `${baseUrl}?api_key=${token}` : `${baseUrl}?api_key=SEU_TOKEN_AQUI`;

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn btn-outline btn-sm gap-2">
        <BarChart2 size={14} />
        Conectar ao Power BI
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="relative w-full max-w-lg rounded-box border border-base-300 bg-base-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-base-300 p-5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <BarChart2 size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold">Conectar ao Power BI</h2>
                <p className="truncate text-sm text-base-content/55">{datasetName}</p>
              </div>
              <button onClick={() => setOpen(false)} className="btn btn-ghost btn-sm btn-square ml-auto shrink-0">
                <X size={16} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-base-300">
              <button
                onClick={() => setTab("desktop")}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${tab === "desktop" ? "border-b-2 border-primary text-primary" : "text-base-content/55 hover:text-base-content"}`}
              >
                <Monitor size={14} /> Power BI Desktop
              </button>
              <button
                onClick={() => setTab("service")}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${tab === "service" ? "border-b-2 border-primary text-primary" : "text-base-content/55 hover:text-base-content"}`}
              >
                <Cloud size={14} /> Power BI Service
              </button>
            </div>

            {/* Content */}
            <div className="space-y-4 p-5">
              {tab === "desktop" && (
                <>
                  <CopyField label="URL OData — cole no campo de URL" value={baseUrl} />

                  <div className="rounded-lg border border-base-300 p-4 text-xs space-y-2.5 text-base-content/70 leading-relaxed">
                    <p className="font-semibold text-base-content text-sm">Passos</p>
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Clique em <strong className="text-base-content">Obter dados → Feed OData</strong></li>
                      <li>Cole a URL acima e clique em <strong className="text-base-content">OK</strong></li>
                      <li>Em autenticação, escolha <strong className="text-base-content">Básica</strong></li>
                      <li>
                        Usuário: qualquer texto (ex: <code className="rounded bg-base-200 px-1">token</code>)<br />
                        Senha: seu token de API do Catworld
                      </li>
                      <li>Clique em <strong className="text-base-content">Conectar</strong> e selecione as tabelas</li>
                    </ol>
                  </div>

                  <div className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-xs text-base-content/70">
                    Para publicar o relatório no Power BI Service com atualização agendada, use a aba <strong>Power BI Service</strong> ao invés desta URL.
                  </div>
                </>
              )}

              {tab === "service" && (
                <>
                  <div className="rounded-lg border border-base-300 p-4 text-xs space-y-2.5 text-base-content/70 leading-relaxed">
                    <p className="font-semibold text-base-content text-sm">Passos no Power BI Service</p>
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Copie a <strong className="text-base-content">URL base</strong> da aba Desktop acima</li>
                      <li>No Power BI Desktop, vá em <strong className="text-base-content">Obter dados → Feed OData</strong> e cole a URL</li>
                      <li>Em autenticação, escolha <strong className="text-base-content">Básica</strong> — usuário: qualquer texto, senha: seu token de API</li>
                      <li>Monte o relatório e publique no Power BI Service</li>
                      <li>No Service, vá em <strong className="text-base-content">Configurações do dataset → Credenciais da fonte de dados</strong></li>
                      <li>Edite a credencial, selecione <strong className="text-base-content">Básica</strong> e informe novamente usuário e token</li>
                      <li>Ative a <strong className="text-base-content">Atualização agendada</strong> — funciona sem gateway</li>
                    </ol>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-base-300 px-5 py-3">
              <a
                href="https://learn.microsoft.com/pt-br/power-bi/connect-data/desktop-connect-odata"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost btn-sm gap-2 text-xs"
              >
                <ExternalLink size={12} />
                Docs Microsoft
              </a>
              <button onClick={() => setOpen(false)} className="btn btn-primary btn-sm">Fechar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
