import { useEffect, useState } from "react";
import { ShieldBan, Plus, Trash2 } from "lucide-react";
import {
  fetchBlocklist,
  addBlock,
  removeBlock,
  purgeBlockedMail,
} from "@/lib/api";
import type { BlockRule, BlockRuleType } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600) return tx("agora há pouco");
  if (abs < 86400) return tx("há {0} h", Math.floor(abs / 3600));
  return tx("há {0} d", Math.floor(abs / 86400));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

export default function BlocklistPage() {
  const [items, setItems] = useState<BlockRule[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<BlockRuleType>("email");
  const [addValue, setAddValue] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<BlockRule | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeSubmitting, setPurgeSubmitting] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBlocklist();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError(tx("Não deu para carregar os bloqueios."));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await fetchBlocklist(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError(tx("Não deu para carregar mais."));
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  function resetAdd() {
    setAddType("email");
    setAddValue("");
    setAddError(null);
    setAddSubmitting(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const value = addValue.trim().toLowerCase();
    if (addType === "email" && !EMAIL_RE.test(value)) {
      setAddError(tx("Informe um e-mail válido."));
      return;
    }
    if (addType === "domain" && !DOMAIN_RE.test(value)) {
      setAddError(tx("Informe só o domínio, por exemplo spammer.com."));
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    try {
      const created = await addBlock({ type: addType, value });
      setItems((prev) => {
        const idx = prev.findIndex((b) => b.id === created.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = created;
          return copy;
        }
        return [created, ...prev];
      });
      setAddOpen(false);
      resetAdd();
    } catch (err) {
      const motivo = err instanceof Error ? err.message : "";
      setAddError(
        motivo && !motivo.startsWith("API error")
          ? motivo
          : tx("Não deu para bloquear. Pode ser um endereço nosso."),
      );
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    try {
      await removeBlock(confirmDelete.id);
      setItems((prev) => prev.filter((b) => b.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch {
      setError(tx("Não deu para desbloquear."));
    }
  }

  async function handlePurge() {
    setPurgeSubmitting(true);
    try {
      const res = await purgeBlockedMail();
      setPurgeResult(
        tx(
          "{0} e-mail(s) excluído(s) de {1} remetente(s) bloqueado(s).",
          res.emailsDeleted,
          res.peopleDeleted,
        ),
      );
    } catch {
      setError(tx("Não deu para excluir os e-mails bloqueados."));
    } finally {
      setPurgeSubmitting(false);
      setPurgeOpen(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={tx("Bloqueios")}
        subtitle={tx(
          "Endereços e domínios bloqueados somem da caixa, e o e-mail novo deles vai para o Spam, onde fica 30 dias.",
        )}
        action={
          <button
            onClick={() => {
              resetAdd();
              setAddOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            {tx("Bloquear")}
          </button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <SectionHeader
              icon={ShieldBan}
              title={`Bloqueados (${items.length}${nextCursor ? "+" : ""})`}
              subtitle={tx("O que chega desses remetentes vai para o Spam.")}
            />
            <button
              onClick={() => {
                setPurgeResult(null);
                setPurgeOpen(true);
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-destructive-subtle hover:text-destructive"
            >
              <Trash2 size={12} />
              {tx("Excluir e-mails bloqueados")}
            </button>
          </div>

          {error && (
            <div className="border-b border-border bg-destructive-subtle/60 px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}
          {purgeResult && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {purgeResult}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              {tx("Carregando…")}
            </p>
          ) : items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-tertiary">
              {tx("Nada bloqueado ainda.")}
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <ShieldBan size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.value}
                        </p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                            item.type === "domain"
                              ? "bg-warning-bg text-warning-text ring-warning-border"
                              : "bg-bg-muted text-text-secondary ring-border",
                          )}
                        >
                          {item.type === "domain"
                            ? tx("Domínio")
                            : tx("E-mail")}
                        </span>
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        {item.createdBy ?? "—"} {tx("· bloqueado")}{" "}
                        {relativeTime(item.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => setConfirmDelete(item)}
                      aria-label={`Desbloquear ${item.value}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      {tx("Desbloquear")}
                    </button>
                  </li>
                ))}
              </ul>
              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    {tx("Carregar mais")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Add dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) resetAdd();
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {tx("Bloquear")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="flex gap-2">
              {(["email", "domain"] as BlockRuleType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAddType(t)}
                  className={cn(
                    "flex-1 rounded-[6px] border px-3 py-2 text-sm font-medium transition-colors",
                    addType === t
                      ? "border-text-primary bg-text-primary/5 text-text-primary"
                      : "border-border text-text-secondary hover:bg-bg-muted",
                  )}
                >
                  {t === "email" ? tx("Endereço") : tx("Domínio")}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder={
                addType === "email"
                  ? tx("pessoa@exemplo.com")
                  : tx("exemplo.com")
              }
              className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
            />
            {addError && (
              <p className="text-xs font-medium text-destructive">{addError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
              >
                {tx("Cancelar")}
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {addSubmitting ? tx("Bloqueando…") : tx("Bloquear")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Unblock confirm */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {tx("Desbloquear?")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            <span className="font-medium text-text-primary">
              {confirmDelete?.value}
            </span>{" "}
            {tx("volta a chegar na caixa, e o e-mail escondido reaparece.")}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
            >
              {tx("Cancelar")}
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {tx("Desbloquear")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Purge confirm */}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {tx("Excluir todos os e-mails bloqueados?")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            {tx(
              "Exclui para sempre todo e-mail escondido de remetentes bloqueados. Não dá para desfazer.",
            )}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPurgeOpen(false)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
            >
              {tx("Cancelar")}
            </button>
            <button
              type="button"
              onClick={handlePurge}
              disabled={purgeSubmitting}
              className="rounded-[6px] bg-destructive px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-destructive/90 disabled:opacity-60"
            >
              {purgeSubmitting ? tx("Excluindo…") : tx("Excluir")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
