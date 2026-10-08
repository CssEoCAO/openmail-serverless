import { useEffect, useState } from "react";
import { Clock, RefreshCw, Send, X } from "lucide-react";
import { fetchOutbox, retryOutboxItem, cancelOutboxItem } from "@/lib/api";
import type { OutboxItem } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return diff >= 0 ? "a qualquer momento" : "agora há pouco";
  const n =
    abs < 3600
      ? `${Math.floor(abs / 60)} min`
      : abs < 86400
        ? `${Math.floor(abs / 3600)} h`
        : `${Math.floor(abs / 86400)} d`;
  return diff >= 0 ? `em ${n}` : `há ${n}`;
}

function StatusChip({ item }: { item: OutboxItem }) {
  const { status } = item;
  // Agendado (horário comercial) é pendente que ainda não tentou nenhuma vez.
  const agendado = status === "pending" && item.attempts === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        status === "pending"
          ? "bg-warning-bg text-warning-text ring-warning-border"
          : "bg-destructive-subtle text-destructive ring-destructive/30",
      )}
    >
      {status === "pending" ? <Clock size={10} /> : <X size={10} />}
      {agendado
        ? "Agendado"
        : status === "pending"
          ? "Tentando de novo"
          : "Falhou"}
    </span>
  );
}

export default function OutboxPage() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOutbox();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Não deu para carregar a saída.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await fetchOutbox(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Não deu para carregar mais.");
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  async function handleRetry(item: OutboxItem) {
    setBusyId(item.id);
    setNotice(null);
    try {
      const res = await retryOutboxItem(item.id);
      if (res.outcome === "sent" || res.outcome === "suppressed") {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setNotice(
          res.outcome === "sent"
            ? `Enviado para ${item.toAddress}.`
            : `${item.toAddress} está na lista de supressão; envio cancelado.`,
        );
      } else {
        setNotice(
          res.outcome === "failed"
            ? `Ainda falhando: o provedor recusou de novo.`
            : `Tentativa feita; aguardando o provedor.`,
        );
        await loadInitial();
      }
    } catch {
      setError("A nova tentativa falhou.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(item: OutboxItem) {
    setBusyId(item.id);
    setNotice(null);
    try {
      await cancelOutboxItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setNotice(`Envio para ${item.toAddress} cancelado.`);
    } catch {
      setError("Não deu para cancelar.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Saída"
        subtitle="Envios agendados e os que o provedor recusou. Os em nova tentativa voltam a sair a cada hora; os que falharam precisam de reenvio manual."
      />

      <div className="space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Send}
              title={`Na fila (${items.length}${nextCursor ? "+" : ""})`}
              subtitle="Envio que deu certo não aparece aqui."
            />
          </div>

          {error && (
            <div className="border-b border-border bg-destructive-subtle/60 px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {notice}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              Carregando…
            </p>
          ) : items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-tertiary">
              Nada esperando para sair.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 px-5 py-3"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Send size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.subject}
                        </p>
                        <StatusChip item={item} />
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        Para {item.toAddress} · de {item.fromAddress} ·{" "}
                        {item.attempts}{" "}
                        {item.attempts === 1 ? "tentativa" : "tentativas"}
                        {item.status === "pending" && item.nextRetryAt
                          ? ` · ${item.attempts === 0 ? "sai" : "próxima"} ${relativeTime(item.nextRetryAt)}`
                          : ""}
                      </p>
                      {item.lastError && (
                        <p className="mt-0.5 truncate text-xs font-light text-destructive">
                          {item.lastError}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => handleRetry(item)}
                        disabled={busyId === item.id}
                        className="inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-60"
                      >
                        <RefreshCw
                          size={12}
                          className={busyId === item.id ? "animate-spin" : ""}
                        />
                        Tentar agora
                      </button>
                      <button
                        onClick={() => handleCancel(item)}
                        disabled={busyId === item.id}
                        className="inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-destructive-subtle hover:text-destructive disabled:opacity-60"
                      >
                        <X size={12} />
                        Cancelar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    Carregar mais
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
