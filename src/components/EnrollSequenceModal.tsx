import { useState, useEffect } from "react";
import { fetchSequences, enrollPerson, type Sequence } from "@/lib/api";

import { tx } from "@/lib/i18n";
import { plural } from "@/lib/datas";
interface EnrollSequenceModalProps {
  personId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  open: boolean;
  onClose: () => void;
  onEnrolled: () => void;
}

export default function EnrollSequenceModal({
  personId,
  personName,
  personEmail,
  recipients,
  open,
  onClose,
  onEnrolled,
}: EnrollSequenceModalProps) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [skipSteps, setSkipSteps] = useState<number[]>([]);
  const [delayOverrides, setDelayOverrides] = useState<Record<string, number>>(
    {},
  );
  const [variables, setVariables] = useState<
    Array<{ key: string; value: string }>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSelectedId("");
    setSkipSteps([]);
    setDelayOverrides({});
    setVariables([]);
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const selectedSequence = sequences.find((s) => s.id === selectedId);

  function toggleSkip(order: number) {
    setSkipSteps((prev) =>
      prev.includes(order) ? prev.filter((o) => o !== order) : [...prev, order],
    );
  }

  function setDelay(order: number, hours: number) {
    setDelayOverrides((prev) => ({ ...prev, [order.toString()]: hours }));
  }

  function addVariable() {
    setVariables([...variables, { key: "", value: "" }]);
  }

  function updateVariable(idx: number, field: "key" | "value", val: string) {
    setVariables(
      variables.map((v, i) => (i === idx ? { ...v, [field]: val } : v)),
    );
  }

  function removeVariable(idx: number) {
    setVariables(variables.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!selectedId) return;
    setSubmitting(true);

    const varsObj: Record<string, string> = {};
    for (const v of variables) {
      if (v.key.trim()) varsObj[v.key.trim()] = v.value;
    }

    try {
      await enrollPerson(selectedId, {
        personId,
        fromAddress,
        variables: varsObj,
        skipSteps,
        delayOverrides,
      });
      onEnrolled();
      onClose();
    } catch (err: any) {
      alert(err.message || tx("Não deu para inscrever a pessoa."));
    } finally {
      setSubmitting(false);
    }
  }

  const activeStepCount = selectedSequence
    ? selectedSequence.steps.filter((s) => !skipSteps.includes(s.order)).length
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-[12px] border border-border bg-card p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          {tx("Inscrever em sequência")}
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          {personName ?? personEmail}
        </p>

        {loading ? (
          <p className="text-sm text-text-tertiary">
            {tx("Carregando sequências…")}
          </p>
        ) : (
          <>
            <select
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setSkipSteps([]);
                setDelayOverrides({});
              }}
              className="mb-4 w-full rounded-md border border-border bg-card ring-1 ring-border px-3 py-2 text-sm text-text-primary"
            >
              <option value="">{tx("Escolha uma sequência…")}</option>
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({plural(s.steps.length, "etapa", "etapas")})
                </option>
              ))}
            </select>

            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-text-secondary">
                {tx("Enviar como")}
              </p>
              <select
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                className="w-full rounded-md border border-border bg-card ring-1 ring-border px-3 py-2 text-sm text-text-primary"
              >
                {recipients.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            {selectedSequence && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-text-secondary">
                  {tx("Etapas")}
                </p>
                <div className="space-y-2">
                  {selectedSequence.steps.map((step, idx) => {
                    const skipped = skipSteps.includes(step.order);
                    const delay =
                      step.order.toString() in delayOverrides
                        ? delayOverrides[step.order.toString()]
                        : step.delayHours;
                    return (
                      <div
                        key={step.order}
                        className={`flex items-center gap-2 rounded border border-border px-3 py-2 text-sm ${skipped ? "opacity-40" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={!skipped}
                          onChange={() => toggleSkip(step.order)}
                          className="accent-accent"
                        />
                        <span className="text-text-tertiary">#{idx + 1}</span>
                        <span className="flex-1 text-text-primary">
                          {step.templateSlug}
                        </span>
                        <input
                          type="number"
                          min={0}
                          value={delay}
                          onChange={(e) =>
                            setDelay(step.order, parseInt(e.target.value) || 0)
                          }
                          className="w-16 rounded border border-border bg-card ring-1 ring-border px-1 py-0.5 text-xs text-text-primary"
                          disabled={skipped}
                        />
                        <span className="text-xs text-text-tertiary">h</span>
                      </div>
                    );
                  })}
                </div>
                {activeStepCount === 0 && (
                  <p className="mt-1 text-xs text-destructive">
                    {tx("Marque pelo menos uma etapa.")}
                  </p>
                )}
              </div>
            )}

            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-text-secondary">
                {tx("Variáveis")}
              </p>
              {variables.map((v, idx) => (
                <div key={idx} className="mb-1 flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={tx("chave")}
                    value={v.key}
                    onChange={(e) => updateVariable(idx, "key", e.target.value)}
                    className="w-28 rounded border border-border bg-card ring-1 ring-border px-2 py-1 text-xs text-text-primary"
                  />
                  <input
                    type="text"
                    placeholder={tx("valor")}
                    value={v.value}
                    onChange={(e) =>
                      updateVariable(idx, "value", e.target.value)
                    }
                    className="flex-1 rounded border border-border bg-card ring-1 ring-border px-2 py-1 text-xs text-text-primary"
                  />
                  <button
                    type="button"
                    onClick={() => removeVariable(idx)}
                    className="text-xs text-destructive"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addVariable}
                className="text-xs font-medium text-primary-ink hover:underline"
              >
                {tx("+ Adicionar variável")}
              </button>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="rounded-[6px] border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-muted"
              >
                {tx("Cancelar")}
              </button>
              <button
                onClick={handleSubmit}
                disabled={!selectedId || submitting || activeStepCount === 0}
                className="rounded-[6px] bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {submitting ? tx("Inscrevendo…") : tx("Inscrever")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
