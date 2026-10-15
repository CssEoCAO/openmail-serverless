import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Code2,
  Eye,
  Sparkles,
  Wand2,
} from "lucide-react";
import HtmlCodeEditor from "@/components/HtmlCodeEditor";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  CodeBlock,
  Field,
  FORM_INPUT_CLASS,
  PaneLabel,
  SectionHeader,
} from "@/components/PageForm";
import { fetchTemplate, createTemplate, updateTemplate } from "@/lib/api";
import {
  analyzeTemplateClient,
  chipLabel,
  isSectionName,
  renderPreview,
  sampleValues,
  sectionChipLabel,
  type TemplateAnalysis,
} from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
const EMPTY_ANALYSIS: TemplateAnalysis = {
  required: [],
  optional: [],
  sections: [],
};

/** Lightweight HTML pretty-printer for the "Format" button — adds line
 *  breaks between adjacent tags and indents nested blocks. */
function formatHtml(input: string): string {
  return input
    .replace(/></g, ">\n<")
    .replace(/\n\s*/g, "\n")
    .split("\n")
    .reduce<{ lines: string[]; indent: number }>(
      (acc, line) => {
        const trimmed = line.trim();
        if (!trimmed) return acc;
        const isClosing = /^<\//.test(trimmed);
        const isSelfClosing =
          /\/>$/.test(trimmed) ||
          /^<(br|hr|img|input|meta|link)\b/i.test(trimmed);
        if (isClosing) acc.indent = Math.max(0, acc.indent - 1);
        acc.lines.push(" ".repeat(acc.indent) + trimmed);
        if (!isClosing && !isSelfClosing && /^<[^/!]/.test(trimmed))
          acc.indent++;
        return acc;
      },
      { lines: [], indent: 0 },
    )
    .lines.join("\n");
}

type ViewMode = "split" | "code" | "preview";

export default function TemplateEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(slug);

  const [name, setName] = useState("");
  const [slugValue, setSlugValue] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isEdit);
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  // A section left open mid-keystroke (e.g. typing "{{#items}}" before its
  // closing tag) is a normal, transient state, not a bug — fall back to an
  // empty analysis rather than crashing the page on every keystroke.
  const analysis = useMemo(() => {
    try {
      return analyzeTemplateClient(subject, bodyHtml);
    } catch {
      return EMPTY_ANALYSIS;
    }
  }, [subject, bodyHtml]);

  const previewHtml = useMemo(() => {
    try {
      return renderPreview(bodyHtml, sampleValues(analysis));
    } catch {
      // Unbalanced sections mid-edit are normal — show the source instead.
      return bodyHtml;
    }
  }, [bodyHtml, analysis]);

  useEffect(() => {
    if (!slug) return;
    fetchTemplate(slug)
      .then((t) => {
        setName(t.name);
        setSlugValue(t.slug);
        setSubject(t.subject);
        setBodyHtml(t.bodyHtml);
      })
      .catch(() => setError(tx("Modelo não encontrado")))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        await updateTemplate(slug!, { name, subject, bodyHtml });
      } else {
        await createTemplate({ slug: slugValue, name, subject, bodyHtml });
      }
      navigate("/templates");
    } catch {
      setError(tx("Não deu para salvar o modelo"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <p className="pt-10 text-sm text-text-tertiary">{tx("Carregando…")}</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Breadcrumb back-link, sits above the page header. */}
      <Link
        to="/templates"
        className="-mt-1 mb-1 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={12} />
        {tx("Modelos")}
      </Link>

      <PageHeader
        title={isEdit ? name || tx("Editar modelo") : tx("Novo modelo")}
        subtitle={
          isEdit && slugValue ? (
            <span className="font-mono">{slugValue}</span>
          ) : (
            tx("E-mail HTML reaproveitável com {{variável}}.")
          )
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/templates")}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {tx("Cancelar")}
            </button>
            <button
              type="button"
              onClick={() => handleSave()}
              disabled={saving}
              className="rounded-[6px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving
                ? tx("Salvando…")
                : isEdit
                  ? tx("Salvar")
                  : tx("Criar modelo")}
            </button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-[6px] border border-destructive/40 bg-destructive-subtle px-4 py-2.5 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        {/* --- Details card --- */}
        <section className="rounded-[8px] bg-card p-5 ring-1 ring-border">
          <SectionHeader
            icon={Sparkles}
            title={tx("Identificação")}
            subtitle={tx(
              "O slug é o identificador fixo que a API e as sequências usam.",
            )}
          />

          <div className="mt-4 space-y-4">
            <Field label={tx("Nome")} hint={tx("Aparece na lista de modelos.")}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tx("Boas-vindas")}
                required
                className={FORM_INPUT_CLASS}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={tx("Slug")}
                hint={
                  isEdit
                    ? tx("O slug não muda depois que o modelo existe.")
                    : tx("Letras minúsculas, números e hífens.")
                }
              >
                <input
                  value={slugValue}
                  onChange={(e) => setSlugValue(e.target.value)}
                  placeholder="boas-vindas"
                  pattern="[a-z0-9-]+"
                  title={tx("Só letras minúsculas, números e hífens")}
                  disabled={isEdit}
                  required
                  className={cn(
                    FORM_INPUT_CLASS,
                    "font-mono",
                    isEdit && "opacity-60",
                  )}
                />
              </Field>

              <Field
                label={tx("Assunto")}
                hint={
                  <>
                    {tx("Use")}{" "}
                    <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
                      {tx("{{variable}}")}
                    </code>{" "}
                    {tx(
                      "para os campos. Aqui é texto puro, não HTML: os valores entram sem escape, diferente do corpo.",
                    )}
                  </>
                }
              >
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={tx("Boas-vindas, {{nome}}!")}
                  required
                  className={FORM_INPUT_CLASS}
                />
              </Field>
            </div>
          </div>
        </section>

        {/* --- Body card with HTML editor + live preview --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                <Code2 size={13} className="text-text-tertiary" />
                {tx("Corpo")}
              </h2>
              <p className="mt-0.5 text-xs font-light text-text-secondary">
                {tx("HTML à esquerda, o e-mail pronto à direita.")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <button
                type="button"
                onClick={() => setBodyHtml(formatHtml(bodyHtml))}
                disabled={!bodyHtml}
                className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wand2 size={11} />
                {tx("Formatar")}
              </button>
            </div>
          </div>

          {/* Inline auto-detected variables, grouped by contract: required
              names fail the send if missing, optional ones render empty,
              and sections need an array/object rather than a plain value.
              Blank when none, so the strip doesn't take space until
              something useful shows up. */}
          {(analysis.required.length > 0 ||
            analysis.optional.length > 0 ||
            analysis.sections.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle/40 px-5 py-2.5">
              <VarGroup
                label={tx("Obrigatórias")}
                // Section names get their own accurate chip (with the right
                // sigil) in the Sections group below — showing them again
                // here as bare `{{name}}` would be a string that never
                // actually appears in the template.
                items={analysis.required
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}}}` }))}
                className="bg-primary-soft text-primary-ink"
              />
              <VarGroup
                label={tx("Opcionais")}
                // Same exclusion: an inverted or `?`-marked section lands in
                // `analysis.optional` too, but its optionality is already
                // shown correctly (as ^ or #...?) in the Sections chip.
                items={analysis.optional
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}?}}` }))}
                className="bg-bg-muted text-text-secondary"
              />
              <VarGroup
                label={tx("Seções")}
                items={analysis.sections.map((s) => ({
                  name: s.name,
                  label: sectionChipLabel(s, analysis),
                }))}
                className="bg-success-subtle text-success"
              />
            </div>
          )}

          <div className="grid h-[520px] grid-cols-1 md:grid-cols-2">
            {/* HTML editor */}
            {viewMode !== "preview" && (
              <div
                className={cn(
                  "flex min-w-0 flex-col",
                  viewMode === "split" &&
                    "border-b border-border md:border-b-0 md:border-r",
                  viewMode === "code" && "md:col-span-2",
                )}
              >
                <PaneLabel>HTML</PaneLabel>
                <div className="min-h-0 flex-1">
                  <HtmlCodeEditor value={bodyHtml} onChange={setBodyHtml} />
                </div>
              </div>
            )}

            {/* Live preview */}
            {viewMode !== "code" && (
              <div
                className={cn(
                  "flex min-w-0 flex-col",
                  viewMode === "preview" && "md:col-span-2",
                )}
              >
                <PaneLabel>{tx("Prévia")}</PaneLabel>
                <div className="min-h-0 flex-1 bg-card">
                  <iframe
                    title={tx("Prévia do e-mail")}
                    sandbox="allow-same-origin"
                    srcDoc={previewHtml}
                    className="h-full w-full bg-white"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* --- Syntax & styling reference (collapsible) --- */}
        <SyntaxCard />

        {/* --- API reference (collapsible, no longer a slide-over) --- */}
        <ApiReferenceCard slug={slugValue || slug || ""} analysis={analysis} />
      </form>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}

function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-[6px] bg-bg-muted/70 p-0.5 ring-1 ring-border">
      <ToggleButton
        active={mode === "code"}
        onClick={() => onChange("code")}
        icon={Code2}
        label={tx("Código")}
      />
      <ToggleButton
        active={mode === "split"}
        onClick={() => onChange("split")}
        icon={Sparkles}
        label={tx("Lado a lado")}
      />
      <ToggleButton
        active={mode === "preview"}
        onClick={() => onChange("preview")}
        icon={Eye}
        label={tx("Prévia")}
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-all",
        active
          ? "bg-card text-text-primary shadow-sm"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

/* ------------------------------- variable chips ------------------------------- */

/** Whether `name` belongs to a section, so plain-variable groups can skip it
 *  — a section already gets its own chip with the correct sigil below. */
function VarGroup({
  label,
  items,
  className,
}: {
  label: string;
  items: Array<{ name: string; label: string }>;
  className: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-text-tertiary">{label}</span>
      {items.map((item) => (
        <code
          key={item.name}
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-[11px]",
            className,
          )}
        >
          {item.label}
        </code>
      ))}
    </div>
  );
}

/* --------------------------- syntax & styling card --------------------------- */

const SYNTAX_ROWS: Array<{ tag: string; meaning: string }> = [
  {
    tag: "{{key}}",
    meaning: tx(
      "Valor, com escape de HTML no corpo. No assunto, que é texto puro, entra sem escape.",
    ),
  },
  {
    tag: "{{{key}}}",
    meaning: tx("Valor cru. Só para HTML gerado pelo seu próprio código."),
  },
  {
    tag: "{{key?}}",
    meaning: tx("Opcional: fica vazio em vez de barrar o envio."),
  },
  {
    tag: "{{key|nl2br}}",
    meaning: tx("Com escape, e as quebras de linha viram <br>."),
  },
  {
    tag: "{{#key}}…{{/key}}",
    meaning: tx("Aparece se tiver valor; repete para cada item de uma lista."),
  },
  {
    tag: "{{#key?}}…{{/key}}",
    meaning: tx("Igual a {{#key}}, mas não barra o envio se faltar."),
  },
  {
    tag: "{{^key}}…{{/key}}",
    meaning: tx("Aparece só se o valor faltar ou estiver vazio."),
  },
  {
    tag: "{{.}}",
    meaning: tx("O item atual, numa lista de textos simples."),
  },
];

const LOOP_SNIPPET = tx(
  "<table>\n  {{#items}}\n    <tr>\n      <td>{{label}}</td>\n      <td>{{currency}}{{price}}</td>\n    </tr>\n  {{/items}}\n</table>\n{{^items}}\n  <p>Nada para mostrar ainda.</p>\n{{/items}}",
);

const MULTILINE_SNIPPET = `<div style="white-space: pre-line">
  {{message}}
</div>`;

function SyntaxCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-muted/30"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <BookOpen size={13} className="text-text-tertiary" />
            {tx("Sintaxe e estilo")}
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            {tx("Todas as marcações e os estilos que valem saber.")}
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border px-5 py-5">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {SYNTAX_ROWS.map((row) => (
                  <tr
                    key={row.tag}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="whitespace-nowrap py-2 pr-4 align-top">
                      <code className="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {row.tag}
                      </code>
                    </td>
                    <td className="py-2 font-light text-text-secondary">
                      {row.meaning}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Field
            label={tx("Listas e estado vazio")}
            hint={tx(
              "Dentro de uma seção o nome procura primeiro no item e depois no nível de cima: {{currency}} pode ficar fora de {{#items}}.",
            )}
          >
            <CodeBlock value={LOOP_SNIPPET} />
          </Field>

          <Field
            label={tx("Valores com várias linhas")}
            hint={tx(
              "O HTML junta as quebras de linha em espaços. Use {{message|nl2br}}, ou mantenha as quebras com um estilo no bloco em volta.",
            )}
          >
            <CodeBlock value={MULTILINE_SNIPPET} />
          </Field>

          <div className="rounded-[6px] border border-warning-border bg-warning-bg px-3 py-2.5 text-xs text-warning-text">
            <strong className="font-medium">{tx("Escape por padrão.")}</strong>{" "}
            {tx(
              "Valor com HTML aparece como texto, então não injeta marcação num e-mail assinado pelo nosso domínio. Use",
            )}{" "}
            <code className="rounded bg-warning-bg px-1 font-mono">
              {tx("{{{key}}}")}
            </code>{" "}
            {tx("só para HTML que o seu próprio código gerou.")}
            <div className="mt-1.5">
              {tx("O escape cobre só")}{" "}
              <code className="font-mono">{`& < > " '`}</code>
              {tx("; não confere URL. Deixe todo atributo entre aspas (")}
              <code className="font-mono">{tx('href="{{url}}"')}</code>
              {tx(", nunca")}{" "}
              <code className="font-mono">{tx("href={{url}}")}</code>
              {tx(") e não ponha valor de fora num")}{" "}
              <code className="font-mono">href</code>{" "}
              {tx("sem conferir o esquema:")}{" "}
              <code className="font-mono">javascript:</code> passa.
            </div>
          </div>

          <div className="rounded-[6px] border border-border bg-bg-subtle/50 px-3 py-2.5 text-xs text-text-secondary">
            <strong className="font-medium text-text-primary">
              {tx("Variável nova afeta quem já envia.")}
            </strong>{" "}
            {tx("Um")}{" "}
            <code className="rounded bg-bg-muted px-1 font-mono">
              {tx("{{key}}")}
            </code>{" "}
            {tx(
              "novo vale assim que você salva, e quem chama sem mandar o valor passa a receber 400. Atualize quem chama antes, ou marque como opcional com",
            )}{" "}
            <code className="rounded bg-bg-muted px-1 font-mono">
              {tx("{{key?}}")}
            </code>
            .
          </div>
        </div>
      )}
    </section>
  );
}

/* ----------------------------- API reference card ----------------------------- */

function ApiReferenceCard({
  slug,
  analysis,
}: {
  slug: string;
  analysis: TemplateAnalysis;
}) {
  const [open, setOpen] = useState(false);
  const variables = analysis.required;

  // A required section name takes an ARRAY of items, not a string. Emitting
  // `"items": "<items>"` here would have the reader send a scalar, which
  // passes validation and then renders one row with every field blank — the
  // send succeeds and the email is silently wrong. (A required section is
  // always non-inverted; an inverted one is optional by definition.)
  const sectionsByName = new Map(analysis.sections.map((s) => [s.name, s]));
  const varsObject = variables.reduce(
    (acc, v) => {
      const section = sectionsByName.get(v);
      acc[v] = section
        ? [
            Object.fromEntries(
              section.variables.map((inner) => [inner, `<${inner}>`]),
            ),
          ]
        : `<${v}>`;
      return acc;
    },
    {} as Record<string, unknown>,
  );

  const curlBody = JSON.stringify(
    {
      to: "recipient@example.com",
      ...(variables.length > 0 ? { variables: varsObject } : {}),
    },
    null,
    2,
  );

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}/api/email-templates/${slug || "<slug>"}/send`;
  const curlCommand = tx(
    'curl -X POST {0} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer <sua-chave-de-api>" \\\n  -d \'{1}\'',
    endpoint,
    curlBody,
  );

  const errorBody = JSON.stringify(
    {
      error: "Missing required template variables",
      missingVariables: variables.length > 0 ? [variables[0]] : [],
      requiredVariables: variables,
    },
    null,
    2,
  );

  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-muted/30"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <Code2 size={13} className="text-text-tertiary" />
            {tx("Enviar pela API")}
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            {tx("Dispare este modelo do seu sistema com um POST autenticado.")}
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border px-5 py-5">
          <Field
            label={tx("Rota")}
            hint={tx("POST nesta URL com corpo em JSON.")}
          >
            <CodeBlock value={`POST ${endpoint}`} oneLine />
          </Field>

          {variables.length > 0 && (
            <Field
              label={tx("Variáveis obrigatórias")}
              hint={tx(
                "Todas precisam ir no corpo da requisição, senão a API devolve 400.",
              )}
            >
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <code
                    key={v}
                    className="rounded-full bg-primary-soft px-2 py-0.5 font-mono text-[11px] text-primary-ink"
                  >
                    {chipLabel(v, analysis)}
                  </code>
                ))}
              </div>
            </Field>
          )}

          <Field label={tx("Exemplo de requisição")}>
            <CodeBlock value={curlCommand} />
          </Field>

          <Field label={tx("Resposta de erro (400)")}>
            <CodeBlock value={errorBody} />
          </Field>
        </div>
      )}
    </section>
  );
}
