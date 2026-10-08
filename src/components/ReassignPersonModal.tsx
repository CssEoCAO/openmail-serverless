import { useState, useEffect } from "react";
import {
  fetchEmail,
  reassignEmailPerson,
  type Email,
  type ReassignPersonResult,
} from "@/lib/api";

interface ReassignPersonModalProps {
  /** The received email being re-associated, or null when closed. */
  email: Email | null;
  /** Current sender label shown for context (the person it's threaded under). */
  currentSender: string;
  open: boolean;
  onClose: () => void;
  onDone: (result: ReassignPersonResult) => void;
}

export default function ReassignPersonModal({
  email,
  currentSender,
  open,
  onClose,
  onDone,
}: ReassignPersonModalProps) {
  const [toEmail, setToEmail] = useState("");
  const [name, setName] = useState("");
  const [prefilledFromReplyTo, setPrefilledFromReplyTo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open, prefill the correspondent address. Prefer inbound Reply-To
  // (contact-form pattern) when it differs from the attributed sender;
  // otherwise fall back to fromAddress. The thread list doesn't carry
  // replyTo, so fetch the single email when needed.
  useEffect(() => {
    if (!open || !email) return;
    setName("");
    setError(null);
    setToEmail("");
    setPrefilledFromReplyTo(false);

    if (email.replyTo) {
      setToEmail(email.replyTo);
      setPrefilledFromReplyTo(true);
      return;
    }
    if (email.fromAddress) {
      setToEmail(email.fromAddress);
      return;
    }
    let cancelled = false;
    fetchEmail(email.id)
      .then((full) => {
        if (cancelled) return;
        if (full.replyTo) {
          setToEmail(full.replyTo);
          setPrefilledFromReplyTo(true);
          return;
        }
        if (full.fromAddress) setToEmail(full.fromAddress);
      })
      .catch(() => {
        /* no address to prefill — leave blank */
      });
    return () => {
      cancelled = true;
    };
  }, [open, email]);

  if (!open || !email) return null;

  async function handleSubmit() {
    if (!email) return;
    const trimmed = toEmail.trim();
    if (!trimmed) {
      setError("Informe um endereço de e-mail.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await reassignEmailPerson(email.id, {
        email: trimmed,
        name: name.trim() || null,
      });
      onDone(result);
      onClose();
    } catch {
      setError(
        "Não deu para mover a mensagem. Confira o endereço e tente de novo.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-[12px] border border-border bg-card p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          Mover mensagem
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          Atribui esta mensagem a outra pessoa, para as respostas chegarem a
          ela. Hoje está com{" "}
          <span className="font-medium text-text-primary">{currentSender}</span>
          .
        </p>

        <label className="mb-1 block text-xs font-medium text-text-secondary">
          E-mail da pessoa
        </label>
        <input
          type="email"
          autoFocus
          value={toEmail}
          onChange={(e) => {
            setToEmail(e.target.value);
            setPrefilledFromReplyTo(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          placeholder="pessoa@exemplo.com"
          className="mb-1 h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:border-primary focus:outline-none"
        />
        {prefilledFromReplyTo && (
          <p className="mb-3 text-[11px] text-text-tertiary">
            Preenchido com o Reply-To da mensagem.
          </p>
        )}

        <label className="mb-1 mt-3 block text-xs font-medium text-text-secondary">
          Nome <span className="text-text-tertiary">(opcional)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          placeholder="Maria Silva"
          className="h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:border-primary focus:outline-none"
        />

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-[6px] border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-muted"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !toEmail.trim()}
            className="rounded-[6px] bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? "Movendo…" : "Mover"}
          </button>
        </div>
      </div>
    </div>
  );
}
