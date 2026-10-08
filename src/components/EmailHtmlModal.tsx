import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  X,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Inbox as InboxIcon,
  MessageSquare,
  Send,
  FileText,
  Code,
  UserPen,
  Check,
  Reply,
} from "lucide-react";
import AttachmentList from "@/components/AttachmentList";
import EmailHtmlFrame from "@/components/EmailHtmlFrame";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import ThreadMessage from "@/components/ThreadMessage";
import {
  fetchPersonEmails,
  fetchStats,
  reassignEmailPerson,
  type Email,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface EmailHtmlModalProps {
  email: Email | null;
  open: boolean;
  onClose: () => void;
  /** Called after the message's From/To (person) is changed in-place. */
  onUpdated?: () => void;
  /** Abre o ReplyComposer para esta mensagem (o pai fecha o modal). */
  onReply?: (emailId: string) => void;
}

function avatarInitial(addr: string | null): string {
  if (!addr) return "?";
  return addr[0]?.toUpperCase() ?? "?";
}

function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const palette = [
    { bg: "rgba(124, 92, 252, 0.14)", fg: "#5b3ce6" },
    { bg: "rgba(34, 197, 94, 0.14)", fg: "#15803d" },
    { bg: "rgba(244, 114, 182, 0.16)", fg: "#be185d" },
    { bg: "rgba(56, 189, 248, 0.16)", fg: "#0369a1" },
    { bg: "rgba(168, 85, 247, 0.14)", fg: "#7e22ce" },
  ];
  return palette[h % palette.length];
}

export default function EmailHtmlModal({
  email,
  open,
  onClose,
  onUpdated,
  onReply,
}: EmailHtmlModalProps) {
  const [view, setView] = useState<"rendered" | "plain">("rendered");
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // In-place re-targeting of who this message is from/to (and, for sent
  // messages, the reply recipient). See the editable From/To rows below.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [toVal, setToVal] = useState("");
  const [fromVal, setFromVal] = useState("");
  const [identities, setIdentities] = useState<string[]>([]);
  // Local overrides so the modal reflects a save without waiting on the parent.
  const [override, setOverride] = useState<{
    from?: string;
    to?: string;
  } | null>(null);
  // Surrounding thread (oldest → newest, including the focal message
  // we re-filter at render time). Always loadable so even chat-mode
  // viewers can see prior messages without leaving the modal.
  const [threadEmails, setThreadEmails] = useState<Email[]>([]);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);

  // Reset internal state when the email changes. Previously this
  // was a `useMemo`-as-side-effect, which is wrong for two reasons:
  // it calls setState during render (React 18+ warns + double-runs
  // under StrictMode), and it runs *before* the new render rather
  // than after, which can leave the focal email's body briefly
  // rendered with the previous thread's expansion state. useEffect
  // gives us the post-render reset point React intends.
  useEffect(() => {
    setView("rendered");
    setCopied(false);
    setFullscreen(false);
    setThreadExpanded(false);
    setThreadEmails([]);
    setEditing(false);
    setEditErr(null);
    setOverride(null);
  }, [email?.id]);

  // Sender identities power the "From" dropdown when re-targeting a sent
  // message. Loaded once per open; harmless for received messages.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchStats()
      .then((s) => {
        if (!cancelled)
          setIdentities((s.senderIdentities ?? []).map((i) => i.email));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load the surrounding thread for this person + inbox when the
  // modal opens. Same call ReplyComposer makes — the response gives
  // us all received + sent emails for that person, scoped to the
  // recipient inbox so we don't leak cross-inbox traffic.
  useEffect(() => {
    if (!open || !email?.personId) return;
    let cancelled = false;
    setThreadLoading(true);
    const recipient = email.recipient ?? email.fromAddress ?? undefined;
    fetchPersonEmails(email.personId, { recipient, limit: 25 })
      .then((res) => {
        if (cancelled) return;
        setThreadEmails(res.emails);
      })
      .catch((err) => {
        // Non-fatal — the body still renders fine without thread context.
        console.warn("Failed to load thread context for view-original", err);
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, email?.id, email?.personId, email?.recipient, email?.fromAddress]);

  // Older messages in the same thread, oldest → newest, excluding the
  // focal message itself (it's already rendered as the modal body).
  // Computed before the `if (!email) return null` early-return so the
  // hook count stays constant across renders — crucial for Rules of
  // Hooks. Returns [] when email is null.
  const priorEmails = useMemo(() => {
    if (!email) return [];
    return threadEmails
      .filter((e) => e.id !== email.id && e.timestamp <= email.timestamp)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [threadEmails, email]);
  const hasThreadContext = priorEmails.length > 0;

  if (!email) return null;

  const isSent = email.type === "sent";
  const downloadable = (email.attachments ?? []).filter((a) => !a.contentId);
  // `override` reflects an in-place edit before the parent refetches. Inline
  // From/To editing is offered for SENT messages (the contact-form case);
  // received messages re-attribute via the per-message Reassign action.
  const fromAddr = override?.from ?? email.fromAddress;
  const toAddr = override?.to ?? (isSent ? email.toAddress : email.recipient);
  const canEdit = isSent;
  const senderForAvatar = isSent ? "you" : (fromAddr ?? email.recipient ?? "?");
  const color = avatarColor(senderForAvatar);

  const ts = new Date(email.timestamp * 1000);
  const fullDate = ts.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const fullTime = ts.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const plainText =
    email.bodyText ||
    (email.bodyHtml
      ? (new DOMParser().parseFromString(email.bodyHtml, "text/html").body
          .textContent ?? "")
      : "");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  function startEdit() {
    setToVal(toAddr ?? "");
    setFromVal(fromAddr ?? "");
    setEditErr(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!email) return;
    const body: { email?: string; fromAddress?: string } = {};
    const newTo = toVal.trim().toLowerCase();
    const newFrom = fromVal.trim().toLowerCase();
    if (newTo && newTo !== (toAddr ?? "").toLowerCase()) body.email = newTo;
    if (newFrom && newFrom !== (fromAddr ?? "").toLowerCase())
      body.fromAddress = newFrom;
    if (!body.email && !body.fromAddress) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setEditErr(null);
    try {
      const res = await reassignEmailPerson(email.id, body);
      setOverride({
        ...(res.email.toAddress != null ? { to: res.email.toAddress } : {}),
        ...(res.email.fromAddress != null
          ? { from: res.email.fromAddress }
          : {}),
      });
      setEditing(false);
      showToast({
        kind: "success",
        message: body.email
          ? `Destinatário trocado para ${body.email}`
          : "Remetente atualizado",
        description: body.email
          ? "As respostas a esta mensagem passam a ir para lá."
          : undefined,
        durationMs: 4500,
      });
      onUpdated?.();
    } catch {
      setEditErr("Não deu para salvar. Confira os endereços e tente de novo.");
    } finally {
      setSaving(false);
    }
  }

  // From options: the current sender first, then the other identities.
  const fromOptions = Array.from(
    new Set([fromAddr, ...identities].filter(Boolean) as string[]),
  );

  return (
    // Non-modal tray (Gmail-style): the inbox stays interactive while
    // viewing the original message. Slightly wider than the compose
    // family because email content is often paragraph-heavy.
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(v) => !v && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={trayContentClass({ fullscreen, width: "viewer" })}
        >
          {/* Slim header — avatar + subject inline. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card pl-3 pr-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: color.bg, color: color.fg }}
              >
                {avatarInitial(senderForAvatar)}
              </span>
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {email.subject || "(sem assunto)"}
              </DialogPrimitive.Title>
              <span
                className={cn(
                  "hidden shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium sm:inline-flex",
                  isSent
                    ? "bg-bg-muted text-text-secondary"
                    : "bg-primary-soft text-primary-ink",
                )}
              >
                {isSent ? <Send size={9} /> : <InboxIcon size={9} />}
                {isSent ? "Enviada" : "Recebida"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {onReply && (
                <button
                  type="button"
                  onClick={() => onReply(email.id)}
                  data-testid="modal-reply"
                  className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  title="Responder a esta mensagem"
                >
                  <Reply size={12} />
                  Responder
                </button>
              )}
              <TrayMaximizeButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((v) => !v)}
              />
              <DialogPrimitive.Close
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                aria-label="Fechar"
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Compact metadata. */}
          <div className="shrink-0 divide-y divide-border/60 border-b border-border bg-bg-subtle/30">
            <TrayMetaRow label="De">
              {editing && canEdit ? (
                <select
                  value={fromVal}
                  onChange={(e) => setFromVal(e.target.value)}
                  className="my-1 h-8 w-full rounded-[6px] border border-border bg-card px-2 text-sm text-text-primary focus:border-primary focus:outline-none"
                >
                  {fromOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center justify-between gap-2 pr-3">
                  <span className="block truncate py-2 text-sm text-text-primary">
                    {fromAddr || (isSent ? "você" : "—")}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={startEdit}
                      data-testid="view-edit-recipient"
                      title="Trocar De / Para"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      <UserPen size={13} />
                    </button>
                  )}
                </div>
              )}
            </TrayMetaRow>
            <TrayMetaRow label="Para">
              {editing && canEdit ? (
                <input
                  type="email"
                  value={toVal}
                  onChange={(e) => setToVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveEdit();
                  }}
                  placeholder="nome@exemplo.com"
                  className="my-1 h-8 w-full rounded-[6px] border border-border bg-card px-2 text-sm text-text-primary focus:border-primary focus:outline-none"
                />
              ) : (
                <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                  {toAddr || "—"}
                </span>
              )}
            </TrayMetaRow>
            {editing && canEdit && (
              <div className="flex items-center justify-end gap-2 px-3 py-2">
                {editErr && (
                  <span className="mr-auto text-xs text-destructive">
                    {editErr}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-muted"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-[6px] bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                >
                  <Check size={12} />
                  {saving ? "Salvando…" : "Salvar"}
                </button>
              </div>
            )}
            <TrayMetaRow label="Data">
              <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                {fullDate} · {fullTime}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label="ID">
              <span className="block truncate py-2 pr-3 font-mono text-xs text-text-tertiary">
                {email.id}
              </span>
            </TrayMetaRow>
          </div>

          {/* Attachments */}
          {downloadable.length > 0 && (
            <div className="shrink-0 border-b border-border bg-card px-4 py-2.5 sm:px-5">
              <p className="mb-2 text-xs font-medium text-text-tertiary">
                {downloadable.length}{" "}
                {downloadable.length !== 1 ? "anexos" : "anexo"}
              </p>
              <AttachmentList variant="list" attachments={downloadable} />
            </div>
          )}

          {/* Body view toggle + actions */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-[8px] bg-bg-muted/70 p-0.5 ring-1 ring-border">
                <button
                  onClick={() => setView("rendered")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-xs font-medium transition-all",
                    view === "rendered"
                      ? "bg-card text-text-primary shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  <FileText size={12} />
                  Original
                </button>
                <button
                  onClick={() => setView("plain")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-xs font-medium transition-all",
                    view === "plain"
                      ? "bg-card text-text-primary shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  <Code size={12} />
                  Só texto
                </button>
              </div>
              {/* Thread expansion. Always available when this email is
                  part of a person's thread — including from chat mode,
                  per the user's "always make it possible" requirement. */}
              {hasThreadContext && (
                <button
                  type="button"
                  onClick={() => setThreadExpanded((v) => !v)}
                  aria-expanded={threadExpanded}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                >
                  <MessageSquare size={12} />
                  {threadExpanded ? "Esconder" : "Mostrar"} {priorEmails.length}{" "}
                  {priorEmails.length === 1 ? "anterior" : "anteriores"}
                  {threadExpanded ? (
                    <ChevronUp size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
              )}
              {!hasThreadContext && threadLoading && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-light text-text-tertiary">
                  <MessageSquare size={11} />
                  Carregando a conversa…
                </span>
              )}
            </div>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {copied ? (
                <>
                  <CheckCircle2 size={12} className="text-success" />
                  Copiado
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Copiar texto
                </>
              )}
            </button>
          </div>

          {/* Body — prior thread (when expanded) sits above the focal
              message so older context flows naturally into the
              current rendering. */}
          <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto bg-card">
            {threadExpanded && hasThreadContext && (
              <div className="border-b border-border bg-bg-subtle/30">
                <div className="flex items-center gap-2 px-4 py-2 sm:px-5">
                  <MessageSquare size={11} className="text-text-tertiary" />
                  <span className="text-[11px] font-medium text-text-tertiary">
                    {priorEmails.length}{" "}
                    {priorEmails.length === 1
                      ? "mensagem anterior nesta conversa"
                      : "mensagens anteriores nesta conversa"}
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {priorEmails.map((e) => (
                    <ThreadMessage key={e.id} email={e} muted />
                  ))}
                </div>
                <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2 sm:px-5">
                  <ChevronDown size={11} className="text-text-tertiary" />
                  <span className="text-[11px] font-medium text-text-tertiary">
                    Esta mensagem
                  </span>
                </div>
              </div>
            )}
            {view === "rendered" && email.bodyHtml ? (
              <EmailHtmlFrame
                html={email.bodyHtml}
                attachments={email.attachments}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words px-5 py-4 font-sans text-sm leading-relaxed text-text-primary sm:px-7 sm:py-5">
                {plainText || "(vazia)"}
              </pre>
            )}
          </div>

          {/* Slim footer — single-line Esc hint. */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-4 py-2 sm:px-5">
            <p className="text-[11px] text-text-tertiary">
              <kbd className="rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                Esc
              </kbd>{" "}
              fecha
            </p>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
