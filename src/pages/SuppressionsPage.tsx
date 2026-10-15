import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Ban, Plus, Trash2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  fetchSuppressions,
  createSuppression,
  deleteSuppression,
} from "@/lib/api";
import type { Suppression } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

import { LOCALE, tx } from "@/lib/i18n";
function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(LOCALE);
}

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600)
    return diff < 0 ? tx("agora há pouco") : tx("em menos de 1 h");
  if (abs < 86400)
    return diff < 0
      ? tx("há {0} h", Math.floor(abs / 3600))
      : tx("em {0} h", Math.floor(abs / 3600));
  const days = Math.floor(abs / 86400);
  return diff < 0 ? tx("há {0} d", days) : tx("em {0} d", days);
}

const REASON_META: Record<
  Suppression["reason"],
  { label: string; chipClass: string }
> = {
  unsubscribe: {
    label: tx("Descadastrou"),
    chipClass: "bg-primary-soft text-primary-ink ring-primary/20",
  },
  manual: {
    label: tx("Manual"),
    chipClass: "bg-bg-muted text-text-secondary ring-border",
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SuppressionsPage() {
  const { data: session } = useSession();
  const [items, setItems] = useState<Suppression[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<Suppression | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSuppressions();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError(tx("Não deu para carregar as supressões."));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetchSuppressions(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError(tx("Não deu para carregar mais."));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (session?.user?.role === "admin") loadInitial();
  }, [session]);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  function resetAddDialog() {
    setAddEmail("");
    setAddError(null);
    setAddSubmitting(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = addEmail.trim().toLowerCase();
    if (!email) {
      setAddError("Informe o e-mail.");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setAddError(tx("Informe um e-mail válido."));
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    try {
      const created = await createSuppression(email);
      setItems((prev) => {
        // Idempotent on the server — if it's already in the list, refresh it
        // in place; otherwise prepend.
        const idx = prev.findIndex((s) => s.id === created.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = created;
          return copy;
        }
        return [created, ...prev];
      });
      setAddOpen(false);
      resetAddDialog();
    } catch {
      setAddError(tx("Não deu para adicionar. Tente de novo."));
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await deleteSuppression(confirmDelete.id);
      setItems((prev) => prev.filter((s) => s.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch {
      setDeleteError(tx("Não deu para remover. Tente de novo."));
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={tx("Supressões")}
        subtitle={tx(
          "Endereços que não recebem envio de sequência nem de marketing.",
        )}
        action={
          <button
            onClick={() => {
              resetAddDialog();
              setAddOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            {tx("Adicionar supressão")}
          </button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Ban}
              title={tx(
                "Endereços suprimidos ({0}{1})",
                items.length,
                nextCursor ? "+" : "",
              )}
              subtitle={tx(
                "Envios pela API (/api/send) e de sequências pulam esses destinatários.",
              )}
            />
          </div>

          {error && (
            <div className="border-b border-border bg-destructive-subtle/60 px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              {tx("Carregando…")}
            </p>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Ban}
              title={tx("Nenhuma supressão ainda")}
              hint={tx(
                "Quem se descadastra entra aqui sozinho. Também dá para adicionar à mão.",
              )}
            />
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => {
                  const meta = REASON_META[item.reason];
                  return (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 px-5 py-3"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                        <Ban size={14} className="text-text-tertiary" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {item.email}
                          </p>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                              meta.chipClass,
                            )}
                          >
                            {meta.label}
                          </span>
                        </div>
                        <p className="truncate text-xs font-light text-text-tertiary">
                          {item.source ?? "—"} {tx("· incluído")}{" "}
                          {relativeTime(item.createdAt)} (
                          {formatDate(item.createdAt)})
                        </p>
                      </div>

                      <button
                        onClick={() => {
                          setDeleteError(null);
                          setConfirmDelete(item);
                        }}
                        aria-label={tx(
                          "Remover a supressão de {0}",
                          item.email,
                        )}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-destructive-subtle hover:text-destructive"
                      >
                        <Trash2 size={12} />
                        {tx("Remover")}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingMore ? tx("Carregando…") : tx("Carregar mais")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* --- Add suppression dialog --- */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAddDialog();
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {tx("Adicionar supressão")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="suppression-email"
                className="block text-xs font-medium text-text-secondary"
              >
                {tx("E-mail")}
              </label>
              <input
                id="suppression-email"
                type="email"
                autoFocus
                required
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder={tx("pessoa@exemplo.com")}
                className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
              />
              <p className="text-[11px] font-light text-text-tertiary">
                {tx(
                  "Envios futuros de sequência e marketing para este endereço serão pulados.",
                )}
              </p>
            </div>

            {addError && (
              <p className="text-xs font-medium text-destructive">{addError}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                {tx("Cancelar")}
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {addSubmitting ? tx("Adicionando…") : tx("Adicionar")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* --- Confirm remove dialog --- */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {tx("Remover a supressão?")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            <span className="font-medium text-text-primary">
              {confirmDelete?.email}
            </span>{" "}
            {tx(
              "volta a receber envios de sequência e marketing. Dá para incluir de novo depois.",
            )}
          </p>

          {deleteError && (
            <p className="text-xs font-medium text-destructive">
              {deleteError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {tx("Cancelar")}
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deleteSubmitting}
              className="rounded-[6px] bg-destructive px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleteSubmitting ? tx("Removendo…") : tx("Remover")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint: string;
}) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-xs font-light text-text-tertiary">{hint}</p>
    </div>
  );
}
