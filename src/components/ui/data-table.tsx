import type { ReactNode } from "react";

export type DataTableColumn<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "center" | "right";
};

const ALIGN_CLASS = { left: "", center: "text-center", right: "text-right" } as const;

/**
 * Tabela padrão das listagens: aplica `.table-stack` (colapsa em cartões no celular, com o rótulo
 * da coluna via `data-label`) por padrão, então nenhuma tela precisa lembrar de adicionar a classe.
 * Não tenta abstrair filtro/paginação — só a estrutura da tabela em si.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  className = "table-sm",
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Renderizado no lugar da tabela quando `rows` está vazio. */
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto">
      <table className={`table table-stack ${className}`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={ALIGN_CLASS[c.align ?? "left"]}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.header} data-label={c.header} className={`${ALIGN_CLASS[c.align ?? "left"]} ${c.className ?? ""}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
