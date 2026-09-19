import Link from "next/link";
import { BookOpen, BarChart2, Cloud, Code, DatabaseZap, FileKey2, FolderKanban, KeyRound, ShieldCheck, UploadCloud, Webhook, ChevronRight } from "lucide-react";
import { articles, categories } from "@/lib/knowledge";

const iconMap: Record<string, React.ElementType> = {
  BookOpen, BarChart2, Cloud, Code, DatabaseZap, FileKey2,
  FolderKanban, KeyRound, ShieldCheck, UploadCloud, Webhook,
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const C = iconMap[name] ?? BookOpen;
  return <C size={size} />;
}

export default function KnowledgePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold">Base de conhecimento</h1>
        <p className="mt-1 text-base-content/65">Guias, referências e tutoriais para usar o Catworld.</p>
      </div>

      {categories.map((cat) => {
        const catArticles = articles.filter((a) => a.category === cat.key);
        if (!catArticles.length) return null;
        return (
          <section key={cat.key}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-base-content/65">{cat.label}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {catArticles.map((a) => (
                <Link
                  key={a.slug}
                  href={`/knowledge/${a.slug}`}
                  className="group flex items-start gap-4 rounded-box border border-base-300 bg-base-100 p-4 transition-colors hover:border-primary/40 hover:bg-base-200"
                >
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon name={a.icon} size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium leading-snug">{a.title}</p>
                      <ChevronRight size={15} className="shrink-0 text-base-content/65 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                    </div>
                    <p className="mt-1 text-sm text-base-content/65 leading-snug">{a.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
