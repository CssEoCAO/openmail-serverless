import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  Code2,
  GripVertical,
  ListOrdered,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  CodeBlock,
  Field,
  FORM_INPUT_CLASS,
  SectionHeader,
} from "@/components/PageForm";
import {
  fetchSequence,
  fetchTemplates,
  createSequence,
  updateSequence,
  type SequenceStep,
  type EmailTemplate,
} from "@/lib/api";
import { analyzeTemplateClient } from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
/** Round delay-hours into a friendlier string for the summary line. */
function formatDelay(hours: number): string {
  if (hours <= 0) return tx("na hora");
  if (hours < 24) return `${hours} h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1
    ? tx("1 dia")
    : tx("{0} dias", String(days).replace(".", ","));
}

/** Cumulative offset from the enrollment start, e.g. "day 3" for the
 *  third step in a {0, 24h, 72h} sequence. */
function formatCumulative(steps: SequenceStep[], idx: number): string {
  const total = steps
    .slice(0, idx + 1)
    .reduce(
      (acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0),
      0,
    );
  if (total === 0) return tx("Dia 0 · sai na hora");
  if (total < 24) return tx("{0} h depois da inscrição", total);
  const days = Math.round((total / 24) * 10) / 10;
  return `Dia ${String(days).replace(".", ",")}`;
}

export default function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEditing = Boolean(id);

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<SequenceStep[]>([
    { order: 1, templateSlug: "", delayHours: 0 },
  ]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tmpls = await fetchTemplates();
        if (cancelled) return;
        setTemplates(tmpls);
        if (id) {
          const seq = await fetchSequence(id);
          if (cancelled) return;
          setName(seq.name);
          setSteps(seq.steps);
        }
      } catch {
        if (!cancelled) setError(tx("Não deu para carregar a sequência."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function addStep() {
    const maxOrder =
      steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    setSteps([
      ...steps,
      { order: maxOrder + 1, templateSlug: "", delayHours: 24 },
    ]);
  }

  function removeStep(order: number) {
    if (steps.length <= 1) return;
    setSteps(steps.filter((s) => s.order !== order));
  }

  function updateStep(
    order: number,
    field: keyof SequenceStep,
    value: SequenceStep[keyof SequenceStep],
  ) {
    setSteps(
      steps.map((s) => (s.order === order ? { ...s, [field]: value } : s)),
    );
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim() || steps.some((s) => !s.templateSlug)) return;
    setSaving(true);
    setError("");
    try {
      if (isEditing && id) {
        await updateSequence(id, { name, steps });
      } else {
        await createSequence({ name, steps });
      }
      navigate("/sequences");
    } catch {
      setError(tx("Não deu para salvar a sequência."));
    } finally {
      setSaving(false);
    }
  }

  const totalSteps = steps.length;
  const totalHours = steps.reduce(
    (acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0),
    0,
  );

  if (loading) {
    return (
      <PageContainer>
        <p className="pt-10 text-sm text-text-tertiary">{tx("Carregando…")}</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Link
        to="/sequences"
        className="-mt-1 mb-1 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={12} />
        {tx("Sequências")}
      </Link>

      <PageHeader
        title={
          isEditing ? name || tx("Editar sequência") : tx("Nova sequência")
        }
        subtitle={
          isEditing
            ? `${totalSteps} step${totalSteps === 1 ? "" : "s"} · spans ${formatDelay(totalHours)}`
            : tx("Monte as etapas; cada e-mail sai sozinho na hora marcada.")
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/sequences")}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {tx("Cancelar")}
            </button>
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={
                saving || !name.trim() || steps.some((s) => !s.templateSlug)
              }
              className="rounded-[6px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving
                ? tx("Salvando…")
                : isEditing
                  ? tx("Salvar")
                  : tx("Criar sequência")}
            </button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-[8px] border border-destructive/40 bg-destructive-subtle px-4 py-2.5 text-xs text-destructive dark:border-destructive/40/30 dark:bg-destructive-subtle dark:text-red-300"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* --- Details card --- */}
        <section className="rounded-[8px] bg-card p-5 ring-1 ring-border">
          <SectionHeader
            icon={Sparkles}
            title={tx("Identificação")}
            subtitle={tx(
              "Um nome claro: é ele que aparece na hora de inscrever alguém.",
            )}
          />

          <div className="mt-4">
            <Field
              label={tx("Nome da sequência")}
              hint={tx("Só administradores veem.")}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tx("Boas-vindas")}
                required
                className={FORM_INPUT_CLASS}
              />
            </Field>
          </div>
        </section>

        {/* --- Steps card --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
            <SectionHeader
              icon={ListOrdered}
              title={tx("Etapas")}
              subtitle={
                <>
                  {totalSteps} {totalSteps === 1 ? "etapa" : "etapas"}{" "}
                  {tx("· dura")}{" "}
                  <span className="font-medium text-text-secondary">
                    {formatDelay(totalHours)}
                  </span>{" "}
                  {tx(
                    "do começo ao fim. O intervalo conta a partir da etapa anterior.",
                  )}
                </>
              }
            />
          </div>

          <ul
            data-testid="sequence-steps"
            className="divide-y divide-border/60"
          >
            {steps.map((step, idx) => (
              <li
                key={step.order}
                data-testid="sequence-step-row"
                data-step-index={idx}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
              >
                <div className="flex shrink-0 items-center gap-2">
                  <GripVertical
                    size={14}
                    className="text-text-tertiary/60"
                    aria-hidden
                  />
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold tabular-nums">
                    <span className="text-primary-ink">{idx + 1}</span>
                  </span>
                </div>

                <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                  <Field
                    label={tx("Modelo")}
                    hint={
                      <span className="text-text-tertiary/80">
                        {formatCumulative(steps, idx)}
                      </span>
                    }
                    className="min-w-0"
                  >
                    <select
                      value={step.templateSlug}
                      onChange={(e) =>
                        updateStep(step.order, "templateSlug", e.target.value)
                      }
                      required
                      className={cn(FORM_INPUT_CLASS, "appearance-none pr-8")}
                    >
                      <option value="" disabled>
                        {tx("Escolha um modelo…")}
                      </option>
                      {templates.map((t) => (
                        <option key={t.slug} value={t.slug}>
                          {t.name} · {t.slug}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label={tx("Intervalo")}
                    hint={
                      idx === 0
                        ? tx("Zero: a etapa 1 sai na inscrição.")
                        : tx("Horas depois da etapa anterior.")
                    }
                    className="sm:w-40"
                  >
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        value={step.delayHours}
                        onChange={(e) =>
                          updateStep(
                            step.order,
                            "delayHours",
                            parseInt(e.target.value, 10) || 0,
                          )
                        }
                        className={cn(FORM_INPUT_CLASS, "pr-12 tabular-nums")}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-tertiary">
                        h
                      </span>
                    </div>
                  </Field>
                </div>

                <button
                  type="button"
                  onClick={() => removeStep(step.order)}
                  disabled={steps.length <= 1}
                  aria-label={tx("Remover etapa")}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 self-end rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 sm:self-auto"
                >
                  <Trash2 size={12} />
                  {tx("Remover")}
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-border bg-bg-subtle/40 px-5 py-3">
            <button
              type="button"
              onClick={addStep}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-dashed border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-text-primary/30 hover:bg-bg-muted hover:text-text-primary"
            >
              <Plus size={12} />
              {tx("Adicionar etapa")}
            </button>
          </div>
        </section>

        {/* --- API reference (only meaningful for existing sequences) --- */}
        {isEditing && id && (
          <ApiReferenceCard
            sequenceId={id}
            steps={steps}
            templates={templates}
          />
        )}
      </form>
    </PageContainer>
  );
}

/* ---------------------------- API reference card ---------------------------- */

function ApiReferenceCard({
  sequenceId,
  steps,
  templates,
}: {
  sequenceId: string;
  steps: SequenceStep[];
  templates: EmailTemplate[];
}) {
  const [open, setOpen] = useState(false);

  // Walk the templates referenced by the sequence's steps and gather the names
  // a caller must supply. The enrollment endpoint validates these against
  // `variables` on the request body.
  //
  // Analyzed with the shared analyzer, not a `{{(\w+)}}` scan. Once sections
  // existed the regex was inverted from the real contract: it collected
  // `{{price}}` from inside a `{{#items}}` body — which resolves per item and
  // is never required — while missing `{{#items}}` itself, which is. The
  // snippet below is meant to be copied and run, so it advertised names the
  // endpoint ignores and omitted the one it rejects the request for.
  const { allVars, perTemplate, sectionFields } = useMemo(() => {
    const usedSlugs = new Set(steps.map((s) => s.templateSlug).filter(Boolean));
    const usedTemplates = templates.filter((t) => usedSlugs.has(t.slug));
    const all = new Set<string>();
    const per: { slug: string; name: string; vars: string[] }[] = [];
    // Section name -> the names its body references, so the sample payload can
    // show an array of objects instead of a string a section cannot use.
    const sections = new Map<string, string[]>();
    for (const t of usedTemplates) {
      let analysis;
      try {
        analysis = analyzeTemplateClient(t.subject, t.bodyHtml);
      } catch {
        // A template stored before write-time validation may not parse. Skip
        // it rather than dropping the whole snippet.
        continue;
      }
      for (const s of analysis.sections) {
        if (!sections.has(s.name)) sections.set(s.name, s.variables);
      }
      for (const v of analysis.required) all.add(v);
      if (analysis.required.length > 0) {
        per.push({ slug: t.slug, name: t.name, vars: analysis.required });
      }
    }
    return {
      allVars: Array.from(all),
      perTemplate: per,
      sectionFields: sections,
    };
  }, [steps, templates]);

  const varsObj =
    allVars.length > 0
      ? Object.fromEntries(
          allVars.map((v) => {
            const fields = sectionFields.get(v);
            // A required section takes an ARRAY of items. Emitting a string
            // here passes validation and then renders one row with every field
            // blank — the enroll succeeds and the mail is silently wrong.
            if (fields) {
              return [
                v,
                [
                  Object.fromEntries(
                    fields.map((f) => [f, `<${f.toUpperCase()}>`]),
                  ),
                ],
              ];
            }
            return [v, `<${v.toUpperCase()}>`];
          }),
        )
      : undefined;

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}/api/sequences/${sequenceId}/enroll`;

  const body = JSON.stringify(
    {
      personEmail: "<RECIPIENT_EMAIL>",
      fromAddress: "<YOUR_SENDING_ADDRESS>",
      ...(varsObj ? { variables: varsObj } : {}),
    },
    null,
    2,
  );

  const curl = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;

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
            {tx("Inscrever pela API")}
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            {tx("Inscreva um contato por programa: mande")}{" "}
            <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
              {tx("personEmail")}
            </code>{" "}
            {tx("(achado ou criado) ou")}{" "}
            <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
              {tx("personId")}
            </code>{" "}
            {tx("(já existente).")}
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
          <Field label={tx("Rota")}>
            <CodeBlock value={`POST ${endpoint}`} oneLine />
          </Field>

          {perTemplate.length > 0 && (
            <Field
              label={tx("Variáveis dos modelos")}
              hint={tx(
                "Todas precisam ir em `variables`, senão a API devolve 400.",
              )}
            >
              <ul className="space-y-1.5 text-xs">
                {perTemplate.map((tv) => (
                  <li
                    key={tv.slug}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="font-medium text-text-primary">
                      {tv.name}
                    </span>
                    <span className="text-text-tertiary">·</span>
                    {tv.vars.map((v) => (
                      <code
                        key={v}
                        className="rounded-full bg-primary-soft px-2 py-0.5 font-mono text-[11px] text-primary-ink"
                      >
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </li>
                ))}
              </ul>
            </Field>
          )}

          <Field label={tx("Exemplo de requisição")}>
            <CodeBlock value={curl} />
          </Field>
        </div>
      )}
    </section>
  );
}
