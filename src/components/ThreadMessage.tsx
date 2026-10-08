import { Send, Inbox as InboxIcon, AlertTriangle, Clock } from "lucide-react";
import EmailHtmlFrame from "@/components/EmailHtmlFrame";
import type { Email } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dataHora } from "@/lib/datas";

interface ThreadMessageProps {
  email: Email;
  /** Slightly de-emphasize this message — used for older context items. */
  muted?: boolean;
  /** Use the card surface for the focal message in a thread. */
  highlight?: boolean;
}

/**
 * Compact summary card for a single message inside a thread context
 * panel — used by ReplyComposer's "Replying to" panel and by
 * EmailHtmlModal's "Show earlier in thread" expansion. The body
 * renders sanitized HTML when present, otherwise the plain-text
 * fallback.
 */
export default function ThreadMessage({
  email,
  muted,
  highlight,
}: ThreadMessageProps) {
  const isSent = email.type === "sent";
  const failedToSend = isSent && email.status === "failed";
  const retrying = isSent && email.status === "retrying";
  const sender = isSent
    ? `você (${email.fromAddress ?? "—"})`
    : (email.fromAddress ?? "desconhecido");
  const recipient = isSent ? email.toAddress : email.recipient;
  const fullStamp = dataHora(email.timestamp);

  return (
    <div
      className={cn(
        "px-4 py-3",
        highlight ? "bg-card" : "bg-transparent",
        muted && "opacity-90",
      )}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] font-semibold",
            failedToSend
              ? "bg-destructive-subtle text-destructive"
              : retrying
                ? "bg-amber-500/10 text-warning-text"
                : isSent
                  ? "bg-bg-muted text-text-secondary"
                  : "bg-primary-soft text-primary-ink",
          )}
          data-testid={retrying ? "message-retrying-badge" : undefined}
          title={
            retrying
              ? "O provedor recusou o envio; vamos tentar de novo sozinhos. Detalhes na Saída."
              : undefined
          }
        >
          {failedToSend ? (
            <>
              <AlertTriangle size={9} />
              Não enviada
            </>
          ) : retrying ? (
            <>
              <Clock size={9} />
              Tentando de novo
            </>
          ) : isSent ? (
            <>
              <Send size={9} />
              Enviada
            </>
          ) : (
            <>
              <InboxIcon size={9} />
              Recebida
            </>
          )}
        </span>
        <span className="truncate font-medium text-text-primary">{sender}</span>
        {recipient && (
          <span className="truncate text-text-tertiary">→ {recipient}</span>
        )}
        <span className="ml-auto shrink-0 text-text-tertiary">{fullStamp}</span>
      </div>
      {email.bodyHtml ? (
        <EmailHtmlFrame
          html={email.bodyHtml}
          attachments={email.attachments}
          collapsedHeight={240}
          className="overflow-hidden rounded-[8px] ring-1 ring-border"
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-text-secondary">
          {email.bodyText || "(sem texto)"}
        </pre>
      )}
    </div>
  );
}
