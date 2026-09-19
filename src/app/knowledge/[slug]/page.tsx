import { notFound } from "next/navigation";
import Link from "next/link";
import {
  BookOpen, BarChart2, Cloud, Code, DatabaseZap, FileKey2,
  FolderKanban, KeyRound, ShieldCheck, UploadCloud, Webhook,
  ChevronLeft, Info, AlertTriangle, Lightbulb, AlertCircle,
} from "lucide-react";
import { getArticle, articles, categories, type Section } from "@/lib/knowledge";

const iconMap: Record<string, React.ElementType> = {
  BookOpen, BarChart2, Cloud, Code, DatabaseZap, FileKey2,
  FolderKanban, KeyRound, ShieldCheck, UploadCloud, Webhook,
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const C = iconMap[name] ?? BookOpen;
  return <C size={size} />;
}

function NoteBlock({ variant, text }: { variant: "info" | "warning" | "tip" | "danger"; text: string }) {
  const cfg = {
    info:    { icon: Info,          cls: "border-info/30 bg-info/8 text-info",              label: "Informação" },
    warning: { icon: AlertTriangle, cls: "border-warning/30 bg-warning/8 text-warning",      label: "Atenção" },
    tip:     { icon: Lightbulb,     cls: "border-success/30 bg-success/8 text-success",      label: "Dica" },
    danger:  { icon: AlertCircle,   cls: "border-error/30 bg-error/8 text-error",            label: "Importante" },
  }[variant];
  const I = cfg.icon;
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 ${cfg.cls}`}>
      <I size={16} className="mt-0.5 shrink-0" />
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{cfg.label}</p>
        <p className="mt-1 text-sm leading-relaxed opacity-90 text-base-content">{text}</p>
      </div>
    </div>
  );
}

function renderSection(s: Section, i: number) {
  switch (s.kind) {
    case "heading":
      return <h2 key={i} className="mt-8 mb-3 text-base font-semibold">{s.text}</h2>;

    case "text":
      return <p key={i} className="text-sm leading-relaxed text-base-content/80">{s.text}</p>;

    case "steps":
      return (
        <ol key={i} className="space-y-2">
          {s.items.map((item, j) => (
            <li key={j} className="flex gap-3 text-sm">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">{j + 1}</span>
              <span className="leading-relaxed text-base-content/80">{item}</span>
            </li>
          ))}
        </ol>
      );

    case "list":
      return (
        <ul key={i} className="space-y-1.5">
          {s.items.map((item, j) => (
            <li key={j} className="flex gap-2 text-sm text-base-content/80">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/50" />
              {item}
            </li>
          ))}
        </ul>
      );

    case "note":
      return <NoteBlock key={i} variant={s.variant} text={s.text} />;

    case "code":
      return (
        <div key={i}>
          {s.label && <p className="mb-1.5 text-xs font-medium text-base-content/65">{s.label}</p>}
          <pre className="overflow-x-auto rounded-lg border border-base-300 bg-base-200 px-4 py-3 text-xs leading-relaxed text-base-content">
            <code>{s.value}</code>
          </pre>
        </div>
      );

    case "table":
      return (
        <div key={i} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-base-300">
                {s.headers.map((h) => (
                  <th key={h} className="pb-2 pr-6 text-left text-xs font-semibold uppercase tracking-wide text-base-content/65">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((row, j) => (
                <tr key={j} className="border-b border-base-300/50 last:border-0">
                  {row.map((cell, k) => (
                    <td key={k} className={`py-2.5 pr-6 align-top leading-snug ${k === 0 ? "font-medium text-base-content" : "text-base-content/70"}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return null;
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const cat = categories.find((c) => c.key === article.category);
  const catArticles = articles.filter((a) => a.category === article.category && a.slug !== slug);

  return (
    <div className="mx-auto max-w-3xl">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-xs text-base-content/65">
        <Link href="/knowledge" className="hover:text-primary">Base de conhecimento</Link>
        <span>/</span>
        <span>{cat?.label}</span>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_220px]">
        {/* Article */}
        <article>
          <div className="mb-6 flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Icon name={article.icon} size={22} />
            </span>
            <div>
              <h1 className="text-xl font-bold leading-snug">{article.title}</h1>
              <p className="mt-1 text-sm text-base-content/65">{article.description}</p>
            </div>
          </div>

          <div className="space-y-4">
            {article.sections.map((s, i) => renderSection(s, i))}
          </div>

          <div className="mt-10 border-t border-base-300 pt-5">
            <Link href="/knowledge" className="btn btn-ghost btn-sm gap-2">
              <ChevronLeft size={14} />
              Voltar para a base de conhecimento
            </Link>
          </div>
        </article>

        {/* Sidebar — outros artigos da mesma categoria */}
        {catArticles.length > 0 && (
          <aside className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-base-content/65">{cat?.label}</p>
            {catArticles.map((a) => (
              <Link
                key={a.slug}
                href={`/knowledge/${a.slug}`}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-base-content/65 hover:bg-base-200 hover:text-base-content"
              >
                <Icon name={a.icon} size={14} />
                {a.title}
              </Link>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

export async function generateStaticParams() {
  return articles.map((a) => ({ slug: a.slug }));
}
