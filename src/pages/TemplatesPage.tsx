import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, FileText, Pencil, Trash2, Hash } from "lucide-react";
import { fetchTemplates, deleteTemplate } from "@/lib/api";
import type { EmailTemplate } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { analyzeTemplateClient } from "@/lib/template-syntax";

/**
 * Count the top-level names a caller can supply — shown as a small badge on
 * each row so the list hints at template complexity without opening the editor.
 *
 * Counted with the shared analyzer rather than a `{{(\w+)}}` scan. The regex
 * was wrong in both directions once sections existed: it counted `{{price}}`
 * inside a `{{#items}}` body, which resolves per item and is not something a
 * caller passes, and it missed `{{#items}}` itself, which is required. A
 * template whose only tags live inside a loop showed a confident, entirely
 * wrong number.
 *
 * Required and optional together, since the badge is about how much a template
 * asks of its caller, not strictly about what would fail a send. A template
 * stored before write-time validation existed may not parse; it counts as 0
 * rather than breaking the list.
 */
function countVariables(t: EmailTemplate): number {
  try {
    const analysis = analyzeTemplateClient(t.subject, t.bodyHtml);
    return new Set([...analysis.required, ...analysis.optional]).size;
  } catch {
    return 0;
  }
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(slug: string) {
    if (!confirm("Excluir este modelo?")) return;
    await deleteTemplate(slug);
    setTemplates((prev) => prev.filter((t) => t.slug !== slug));
  }

  return (
    <PageContainer>
      <PageHeader
        title="Modelos de e-mail"
        subtitle="Modelos HTML reaproveitáveis com {{variável}}. Usados na resposta, nas sequências e pela API."
        action={
          <button
            onClick={() => navigate("/templates/new")}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            Novo modelo
          </button>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm text-text-tertiary">Carregando…</p>
        ) : templates.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <p className="mb-1 text-sm font-medium text-text-primary">
              Nenhum modelo ainda
            </p>
            <p className="text-xs font-light text-text-tertiary">
              Crie o primeiro pelo botão "Novo modelo".
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {templates.map((t) => {
                const varCount = countVariables(t);
                return (
                  <li
                    key={t.id}
                    data-testid="template-row"
                    data-template-name={t.name}
                    data-template-slug={t.slug}
                    className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                  >
                    <Link
                      to={`/templates/${t.slug}/edit`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                        <FileText size={14} className="text-text-tertiary" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {t.name}
                          </p>
                          {varCount > 0 && (
                            <span
                              title={`${varCount} ${varCount === 1 ? "variável" : "variáveis"}`}
                              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary-soft px-1.5 py-0.5 font-mono text-[11px] text-primary-ink"
                            >
                              <Hash size={9} />
                              {varCount}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs font-light text-text-tertiary">
                          <span className="font-mono">{t.slug}</span> ·{" "}
                          {t.subject}
                        </p>
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => navigate(`/templates/${t.slug}/edit`)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                      >
                        <Pencil size={12} />
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(t.slug)}
                        aria-label="Excluir"
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
