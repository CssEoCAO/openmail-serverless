import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, ListOrdered, Pencil, Trash2, Clock } from "lucide-react";
import { fetchSequences, deleteSequence, type Sequence } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";

/** Round delay-hours into a friendlier string for the row chip. */
function formatTotalDelay(hours: number): string {
  if (hours <= 0) return "na hora";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 dia" : `${days} dias`;
}

function totalDurationHours(seq: Sequence): number {
  return seq.steps.reduce((acc, s) => acc + (s.delayHours || 0), 0);
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    if (!confirm("Excluir esta sequência?")) return;
    try {
      await deleteSequence(id);
      setSequences((prev) => prev.filter((s) => s.id !== id));
    } catch {
      alert("Não deu para excluir: a sequência pode ter inscrições ativas.");
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Sequências"
        subtitle="Campanhas em etapas: inscreva um contato e os modelos saem na agenda definida."
        action={
          <button
            onClick={() => navigate("/sequences/new")}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            Nova sequência
          </button>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm text-text-tertiary">Carregando…</p>
        ) : sequences.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <p className="mb-1 text-sm font-medium text-text-primary">
              Nenhuma sequência ainda
            </p>
            <p className="mb-4 text-xs font-light text-text-tertiary">
              Monte a primeira campanha em etapas para acompanhar contatos sem
              esforço.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {sequences.map((seq) => {
                const total = totalDurationHours(seq);
                return (
                  <li
                    key={seq.id}
                    data-testid="sequence-row"
                    data-sequence-id={seq.id}
                    className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                  >
                    <Link
                      to={`/sequences/${seq.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                        <ListOrdered size={14} className="text-text-tertiary" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {seq.name}
                          </p>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium tabular-nums text-primary-ink">
                            {seq.steps.length}{" "}
                            {seq.steps.length === 1 ? "etapa" : "etapas"}
                          </span>
                        </div>
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-light text-text-tertiary">
                          <Clock size={10} />
                          dura {formatTotalDelay(total)}
                        </p>
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                      >
                        <Pencil size={12} />
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(seq.id)}
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
