import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import {
  Link2,
  Maximize2,
  Trash2,
  UserPen,
  ArrowDown,
  Check,
  Reply,
} from "lucide-react";
import type { Email } from "@/lib/api";
import { fetchDraft } from "@/lib/api";
import type { ThreadInboxGroup } from "@/components/ThreadInboxSection";
import AttachmentList from "@/components/AttachmentList";
import ChatQuickReply from "@/components/ChatQuickReply";
import RascunhoPill from "@/components/RascunhoPill";
import { useRascunhos } from "@/lib/rascunho";
import CcChips, { RosterDiffNotice } from "@/components/CcChips";
import EmailHtmlFrame from "@/components/EmailHtmlFrame";
import { rosterOf, diffRosters } from "@/lib/roster";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { copyMessageLink, messageDomId } from "@/lib/message-link";
import { rotuloDia, soHora } from "@/lib/datas";
import {
  HIDE_SIGNATURES_EVENT,
  readHideSignatures,
  stripSignatureFromHtml,
  stripSignatureFromText,
} from "@/lib/signatures";

import { tx } from "@/lib/i18n";
interface ChatInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  /** Domains we treat as "internal" for CC chip coloring. */
  internalDomains?: string[];
  /**
   * Per-bubble sender override — used in group conversations to label
   * each received bubble with the actual sender's name. Returns null
   * to fall back to the default behavior.
   */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
  /**
   * Abre o ReplyComposer para UMA mensagem. Sem isso o chat so tinha o
   * ChatQuickReply fixo embaixo (que responde ao ultimo recebido) e nenhum
   * jeito de retomar um rascunho — foi o "nao acho o botao responder".
   * Opcional porque a pagina de conversa em grupo ainda nao tem composer.
   */
  onReply?: (emailId: string) => void;
  onSent: () => void;
  /**
   * Optional handoff to the global compose drawer. When provided, the
   * sticky reply renders an "open in compose" button that fires this
   * callback with a prefilled context (from + to + cc + subject) so the
   * user can keep typing in the full editor — change sender identity,
   * add a teammate to CC, attach files, etc.
   */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
}

const BUBBLE_TRUNCATE_CHARS = 480;

function emailToText(email: Email): string {
  if (email.bodyText) return email.bodyText;
  if (email.bodyHtml) {
    return (
      new DOMParser().parseFromString(email.bodyHtml, "text/html").body
        .textContent ?? ""
    );
  }
  return "";
}

/**
 * Received mail always shows its original HTML. Sent bubbles keep the chat
 * look unless the HTML is significantly richer than the plain-text fallback.
 */
function shouldShowHtmlPreview(email: Email): boolean {
  const txt = email.bodyText?.trim() ?? "";
  const html = email.bodyHtml ?? "";
  if (!html) return false;
  if (email.type === "received") return true;
  if (!txt) return true;
  // Plain text exists but the HTML is significantly richer — render preview.
  const looksMarketingy = /<table|<style|class="/i.test(html);
  return looksMarketingy && html.length > 4000;
}

interface BubbleProps {
  email: Email;
  internalDomains?: string[];
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
  onReply?: (emailId: string) => void;
}

function Bubble({
  email,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onReassign,
  onReply,
}: BubbleProps) {
  // Resolve the sender label for received bubbles. In a group conversation,
  // each received bubble is from a different person; senderResolver lets
  // the parent supply per-message identity. Falls back to nothing for 1-on-1.
  const senderOverride = senderResolver?.(email) ?? null;
  const temRascunho = useRascunhos().porEmail.has(email.id);
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  // Subscribe to the local "Hide signatures in chat" preference. When on,
  // we strip the trailing signature block from each bubble's body so the
  // chat feed stays scannable. Updates instantly on toggle thanks to a
  // custom event from `lib/signatures.ts`.
  const [hideSignatures, setHideSignatures] = useState(() =>
    readHideSignatures(),
  );
  useEffect(() => {
    function refresh() {
      setHideSignatures(readHideSignatures());
    }
    window.addEventListener(HIDE_SIGNATURES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(HIDE_SIGNATURES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Apply the strip to a per-bubble copy of the email so downstream useMemos
  // operate on the pruned text/html rather than the raw originals.
  const visibleEmail = useMemo<Email>(() => {
    if (!hideSignatures) return email;
    return {
      ...email,
      bodyText: email.bodyText ? stripSignatureFromText(email.bodyText) : null,
      bodyHtml: email.bodyHtml ? stripSignatureFromHtml(email.bodyHtml) : null,
    };
  }, [email, hideSignatures]);

  const text = useMemo(() => emailToText(visibleEmail), [visibleEmail]);
  const showHtmlPreview = useMemo(
    () => shouldShowHtmlPreview(visibleEmail),
    [visibleEmail],
  );
  const truncated = text.length > BUBBLE_TRUNCATE_CHARS && !expanded;
  const displayText = truncated
    ? text.slice(0, BUBBLE_TRUNCATE_CHARS).trimEnd() + "…"
    : text;

  const stamp = soHora(email.timestamp);

  function handleClick() {
    if (isUnread) onMarkRead(email);
  }

  // Sender label: only shown on received bubbles in group conversations
  // (i.e. when senderOverride is supplied). Keeps 1-on-1 chats clean.
  const senderLabel =
    !isSent && senderOverride
      ? senderOverride.name && senderOverride.name.trim()
        ? senderOverride.name
        : senderOverride.email
      : null;

  return (
    <div
      id={messageDomId(email.id)}
      data-testid="chat-bubble"
      data-email-id={email.id}
      className={`group flex flex-col px-4 py-1 sm:px-6 scroll-mt-20 ${
        isSent ? "items-end" : "items-start"
      }`}
      onClick={handleClick}
      title={email.subject ?? undefined}
    >
      {senderLabel && (
        <span
          className="mb-0.5 max-w-[85%] truncate px-2 text-[10px] font-medium uppercase tracking-wider text-text-tertiary sm:max-w-[78%]"
          title={senderOverride?.email}
        >
          {senderLabel}
        </span>
      )}
      {showHtmlPreview ? (
        <div
          data-testid="chat-html-preview"
          className={`relative w-full max-w-[85%] overflow-hidden rounded-[12px] bg-white text-left text-[#181a20] ring-1 ring-border sm:max-w-[78%] ${
            isUnread ? "outline outline-2 outline-violet/40" : ""
          }`}
        >
          <EmailHtmlFrame
            html={visibleEmail.bodyHtml ?? ""}
            attachments={email.attachments}
            collapsedHeight={360}
          />
        </div>
      ) : (
        <div
          className={`max-w-[85%] rounded-[12px] px-3.5 py-2 text-sm leading-relaxed sm:max-w-[78%] ${
            isSent
              ? "bg-text-primary text-card dark:bg-primary/25 dark:text-text-primary"
              : "bg-card text-text-primary ring-1 ring-border"
          } ${isUnread ? "outline outline-2 outline-violet/40" : ""}`}
        >
          {displayText ? (
            <p className="whitespace-pre-wrap break-words">{displayText}</p>
          ) : (
            <p className="italic opacity-60">{tx("(sem texto)")}</p>
          )}
          {text.length > BUBBLE_TRUNCATE_CHARS && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className={`mt-1.5 text-xs font-medium underline-offset-2 hover:underline ${
                isSent ? "opacity-80" : "text-text-secondary"
              }`}
            >
              {expanded ? tx("Mostrar menos") : tx("Mostrar tudo")}
            </button>
          )}
        </div>
      )}

      {/* CC chips — sit just below the bubble */}
      {email.cc && email.cc.length > 0 && (
        <div
          className={`mt-1 flex max-w-[85%] sm:max-w-[78%] ${
            isSent ? "justify-end" : "justify-start"
          }`}
        >
          <CcChips
            cc={email.cc}
            internalDomains={internalDomains}
            variant="compact"
          />
        </div>
      )}

      <AttachmentList
        attachments={email.attachments ?? []}
        className={`mt-1.5 max-w-[85%] sm:max-w-[78%] ${
          isSent ? "justify-end" : "justify-start"
        }`}
      />

      <div
        className={`mt-1 flex items-center gap-2 text-[10px] text-text-tertiary ${isSent ? "flex-row-reverse" : ""}`}
      >
        <span>{stamp}</span>
        {isSent && email.status !== "failed" && (
          <Check
            size={11}
            className="text-text-tertiary"
            aria-label={tx("Enviada")}
          />
        )}
        {email.bodyHtml && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="flex items-center gap-1 hover:text-text-secondary"
            title={tx("Ver a mensagem original")}
          >
            <Maximize2 size={10} />
            {tx("Ver original")}
          </button>
        )}
        {onReply && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReply(email.id);
            }}
            data-testid="message-reply"
            className="flex items-center gap-1 hover:text-text-secondary"
            title={temRascunho ? tx("Continuar rascunho") : tx("Responder")}
          >
            <Reply size={10} />
            {temRascunho ? tx("Continuar rascunho") : tx("Responder")}
          </button>
        )}
        {temRascunho && <RascunhoPill />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void copyMessageLink(email.id);
          }}
          data-testid="message-copy-link"
          className="flex items-center gap-1 opacity-0 transition-opacity hover:text-text-secondary group-hover:opacity-100"
          title={tx("Copiar link desta mensagem")}
        >
          <Link2 size={10} />
        </button>
        {onReassign && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReassign(email);
            }}
            data-testid="message-reassign"
            className="flex items-center gap-1 opacity-0 transition-opacity hover:text-text-secondary group-hover:opacity-100"
            title={tx("Mover para outra pessoa")}
          >
            <UserPen size={10} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(email.id);
          }}
          className="flex items-center gap-1 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          title={tx("Excluir mensagem")}
        >
          <Trash2 size={10} />
        </button>
        {isUnread && !isSent && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary"
            aria-label={tx("Não lida")}
          />
        )}
      </div>
    </div>
  );
}

interface DaySeparatorProps {
  label: string;
}
function DaySeparator({ label }: DaySeparatorProps) {
  return (
    <div className="flex items-center gap-2 px-6 py-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-card px-3 py-0.5 text-[11px] font-medium text-text-tertiary">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export default function ChatInboxSection({
  group,
  personEmail: _personEmail,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onReassign,
  onReply,
  onSent,
  onOpenCompose,
}: ChatInboxSectionProps) {
  // Chronological order — oldest at top, newest at bottom.
  const chronological = useMemo(
    () => [...group.emails].reverse(),
    [group.emails],
  );

  // Group items by day for separators, and emit roster-diff notices
  // between consecutive messages where the *full* participant set
  // changes — not just CC. Diffing CC alone produces false positives
  // because the sender of a given message naturally isn't in their
  // own CC, so every speaker rotation looked like "X removed · Y added".
  const items = useMemo(() => {
    const out: Array<
      | { kind: "day"; key: string; label: string }
      | {
          kind: "roster";
          key: string;
          prev: Email["cc"];
          next: Email["cc"];
        }
      | { kind: "msg"; email: Email }
    > = [];
    let lastDay = "";
    let lastEmail: Email | null = null;
    let lastRoster: Email["cc"] = [];
    for (const email of chronological) {
      const label = rotuloDia(email.timestamp);
      if (label !== lastDay) {
        out.push({ kind: "day", key: `day-${label}-${email.id}`, label });
        lastDay = label;
      }
      const nextRoster = rosterOf(email, senderResolver);
      if (lastEmail) {
        const { joined, left } = diffRosters(lastRoster, nextRoster);
        if (joined.length || left.length) {
          out.push({
            kind: "roster",
            key: `roster-${lastEmail.id}-${email.id}`,
            prev: lastRoster,
            next: nextRoster,
          });
        }
      }
      out.push({ kind: "msg", email });
      lastEmail = email;
      lastRoster = nextRoster;
    }
    return out;
  }, [chronological, senderResolver]);

  const replyTarget = useMemo(
    () => group.emails.find((e) => e.type === "received") ?? null,
    [group.emails],
  );

  // CC carried into the inline reply so chat-bubble sends default to
  // "reply-all" — matches the full ReplyComposer's behavior. Strip our
  // own inbox so we don't CC ourselves.
  const replyCc = useMemo(() => {
    const ownInbox = group.inbox.toLowerCase();
    return (replyTarget?.cc ?? []).filter(
      (c) => c.email.toLowerCase() !== ownInbox,
    );
  }, [replyTarget, group.inbox]);

  // Build the seed values for the full compose drawer. We pull the most
  // recent received email's recipient list so switching to compose
  // carries the original CC roster + subject through (minus our own
  // inbox, which is "us" and would be redundant on the To/Cc lines).
  const handleOpenInCompose = onOpenCompose
    ? async () => {
        const sender = replyTarget
          ? (senderResolver?.(replyTarget) ?? null)
          : null;
        const to =
          sender?.email ?? replyTarget?.fromAddress ?? _personEmail ?? "";
        const cc = replyCc;
        const baseSubject = replyTarget?.subject ?? "";
        const subject =
          baseSubject && !/^re:\s/i.test(baseSubject)
            ? `Re: ${baseSubject}`
            : baseSubject;
        // Carry a saved reply draft's body into the full editor so it's
        // visible here too, not just in the inline quick-reply box.
        let bodyHtml: string | undefined;
        if (replyTarget) {
          try {
            const draft = await fetchDraft(`reply:${replyTarget.id}`);
            if (draft?.bodyHtml) bodyHtml = draft.bodyHtml;
          } catch {
            // Best-effort — fall back to an empty body on failure.
          }
        }
        onOpenCompose({
          from: group.inbox,
          to,
          cc,
          subject,
          ...(bodyHtml ? { bodyHtml } : {}),
        });
      }
    : undefined;

  // Scroll state for the messages pane
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const previousMsgIdsRef = useRef<Set<string>>(new Set());

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
    setHasNewBelow(false);
    setIsAtBottom(true);
  }

  useLayoutEffect(() => {
    // Initial mount: jump to latest without animation
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = new Set(chronological.map((e) => e.id));
    const prev = previousMsgIdsRef.current;
    let hasNew = false;
    for (const id of ids) {
      if (!prev.has(id)) {
        hasNew = true;
        break;
      }
    }
    previousMsgIdsRef.current = ids;
    if (!hasNew) return;
    if (isAtBottom) {
      // User is already at bottom: keep them pinned to latest.
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      // User scrolled up: surface a "new message" indicator instead.
      setHasNewBelow(true);
    }
  }, [chronological, isAtBottom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    setIsAtBottom(atBottom);
    if (atBottom) setHasNewBelow(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle">
      {/* Scrollable messages area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Top fade — hints at scrollable content above */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-bg-subtle/60 to-transparent"
          aria-hidden
        />

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="smooth-scroll flex-1 overflow-y-auto py-2"
        >
          {items.map((item) =>
            item.kind === "day" ? (
              <DaySeparator key={item.key} label={item.label} />
            ) : item.kind === "roster" ? (
              <RosterDiffNotice
                key={item.key}
                prev={item.prev ?? []}
                next={item.next ?? []}
                internalDomains={internalDomains}
              />
            ) : (
              <Bubble
                key={item.email.id}
                email={item.email}
                internalDomains={internalDomains}
                senderResolver={senderResolver}
                onOpenHtml={onOpenHtml}
                onMarkRead={onMarkRead}
                onDelete={onDelete}
                onReassign={onReassign}
                onReply={onReply}
              />
            ),
          )}
          <div ref={bottomRef} className="h-2" />
        </div>

        {/* Bottom fade — hints at scrollable content below */}
        {!isAtBottom && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-bg-subtle/70 to-transparent"
            aria-hidden
          />
        )}

        {/* Floating "Jump to latest" pill */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            className={`absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg transition-all ${
              hasNewBelow
                ? "bg-primary text-primary-foreground"
                : "bg-card text-text-primary ring-1 ring-border"
            }`}
          >
            <ArrowDown size={12} />
            {hasNewBelow ? tx("Mensagens novas") : tx("Ir para a mais recente")}
          </button>
        )}
      </div>

      {/* Sticky reply at the bottom of the section */}
      <div className="shrink-0">
        <ChatQuickReply
          inboxAddress={group.inbox}
          latestReceivedEmailId={replyTarget?.id ?? null}
          personEmail={_personEmail}
          replyCc={replyCc}
          onSent={onSent}
          onOpenCompose={handleOpenInCompose}
        />
      </div>
    </div>
  );
}
