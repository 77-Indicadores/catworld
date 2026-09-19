import type { ButtonHTMLAttributes, ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleX, Clock3 } from "lucide-react";
import type { Status } from "@/lib/types";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>}
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm text-base-content/65">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Button({ children, variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "outline" | "error" }) {
  const styles = {
    primary: "btn-primary",
    secondary: "btn-secondary",
    ghost: "btn-ghost",
    outline: "btn-outline",
    error: "btn-error",
  };
  return <button className={`btn btn-sm ${styles[variant]} ${className}`} {...props}>{children}</button>;
}

export function Panel({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: string; action?: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-box border border-base-300 bg-base-100 shadow-sm ${className}`}>
      {(title || action) && <div className="flex items-center justify-between gap-3 border-b border-base-300 px-5 py-4"><h2 className="font-semibold">{title}</h2>{action}</div>}
      {children}
    </section>
  );
}

export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const config = {
    healthy: { cls: "badge-success", text: "Saudável", Icon: CheckCircle2 },
    warning: { cls: "badge-warning", text: "Atenção", Icon: CircleAlert },
    error: { cls: "badge-error", text: "Erro", Icon: CircleX },
    inactive: { cls: "badge-ghost", text: "Inativo", Icon: Clock3 },
  }[status];
  return <span className={`badge badge-sm gap-1 ${config.cls}`}><config.Icon size={12} />{label ?? config.text}</span>;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 rounded-2xl bg-base-200 p-4 text-base-content/65">{icon}</div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-base-content/65">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, icon }: { label: string; value: string; hint: string; icon: ReactNode }) {
  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/65">{label}</p>
          <p className="mt-2 text-2xl font-bold">{value}</p>
          <p className="mt-1 text-xs text-base-content/65">{hint}</p>
        </div>
        <div className="rounded-xl bg-primary/10 p-2.5 text-primary">{icon}</div>
      </div>
    </div>
  );
}
