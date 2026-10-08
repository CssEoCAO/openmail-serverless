import { useState } from "react";
import {
  AlertTriangle,
  Clock,
  Link2,
  Maximize2,
  Trash2,
  UserPen,
  Reply as ReplyIcon,
} from "lucide-react";
import RascunhoPill from "@/components/RascunhoPill";
import { useRascunhos } from "@/lib/rascunho";
import AttachmentList from "@/components/AttachmentList";
import CcChips from "@/components/CcChips";
import EmailHtmlFrame from "@/components/EmailHtmlFrame";
import Monograma from "@/components/Monograma";
import type { Email } from "@/lib/api";
import { copyMessageLink, messageDomId } from "@/lib/message-link";
import { dataHora } from "@/lib/datas";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  email: Email;
  personEmail: string;
  personName?: string | null;
  /** Domínios nossos (identidades de envio): CC interno tem outra cor. */
  internalDomains?: string[];
  /**
   * Remetente por mensagem, para conversa em grupo (cada uma de uma pessoa).
   * `null` cai no padrão: "Você" no enviado, a pessoa no recebido.
   */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  /** Mover a mensagem para outra pessoa (ou uma nova). Sem isso, a ação some. */
  onReassign?: (email: Email) => void;
}

/** Texto puro da mensagem, para o resumo da linha recolhida. */
export function textoDe(email: Email): string {
  if (email.bodyText) return email.bodyText;
  if (email.bodyHtml)
    return (
      new DOMParser().parseFromString(email.bodyHtml, "text/html").body
        .textContent ?? ""
    );
  return "";
}

export function remetenteDe(
  email: Email,
  personEmail: string,
  personName: string | null | undefined,
  senderResolver?: MessageBubbleProps["senderResolver"],
): { nome: string; email: string } {
  if (email.type === "sent")
    return { nome: "Você", email: email.fromAddress ?? "" };
  const o = senderResolver?.(email) ?? null;
  if (o) return { nome: o.name?.trim() || o.email, email: o.email };
  return {
    nome: personName?.trim() || email.fromAddress || personEmail,
    email: email.fromAddress || personEmail,
  };
}

const LIMITE_TEXTO = 640;

const acao =
  "inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-xs text-text-tertiary transition-colors hover:bg-text-primary/[0.05] hover:text-text-primary";

/** Uma mensagem aberta no modo fio (cartão com cabeçalho, corpo, anexos e ações). */
export default function MessageBubble({
  email,
  personEmail,
  personName,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onReassign,
}: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const temRascunho = useRascunhos().porEmail.has(email.id);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;
  const falhou = isSent && email.status === "failed";
  const tentando = isSent && email.status === "retrying";
  const de = remetenteDe(email, personEmail, personName, senderResolver);
  const para = isSent ? email.toAddress || personEmail : email.recipient || "";

  const texto = email.bodyHtml ? "" : textoDe(email);
  const cortado = texto.length > LIMITE_TEXTO && !expanded;

  return (
    <article
      id={messageDomId(email.id)}
      data-testid="thread-message"
      data-email-id={email.id}
      onClick={() => isUnread && onMarkRead(email)}
      className={cn(
        "min-w-0 scroll-mt-20 rounded-[6px] border bg-card",
        falhou
          ? "border-destructive/40"
          : tentando
            ? "border-warning-border"
            : isUnread
              ? "border-primary/40"
              : "border-border",
      )}
    >
      <header className="flex items-start gap-3 px-4 pb-2 pt-3">
        <Monograma nome={isSent ? "Você" : de.nome} email={de.email} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">
            <span className="font-semibold text-text-primary">{de.nome}</span>
            {de.email && de.email !== de.nome && (
              <span className="text-text-tertiary"> &lt;{de.email}&gt;</span>
            )}
          </p>
          <p className="truncate text-xs text-text-tertiary">para {para}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {falhou && (
            <span
              data-testid="message-failed-badge"
              title="O provedor recusou esta mensagem; ela não foi entregue."
              className="inline-flex items-center gap-1 rounded-[4px] bg-destructive-subtle px-1.5 py-0.5 text-[11px] font-semibold text-destructive"
            >
              <AlertTriangle size={11} />
              Não enviada
            </span>
          )}
          {tentando && (
            <span
              data-testid="message-retrying-badge"
              title="O provedor recusou o envio; vamos tentar de novo sozinhos. Detalhes na Saída."
              className="inline-flex items-center gap-1 rounded-[4px] bg-warning-bg px-1.5 py-0.5 text-[11px] font-semibold text-warning-text"
            >
              <Clock size={11} />
              Tentando de novo
            </span>
          )}
          <time className="text-xs text-text-tertiary tabular-nums">
            {dataHora(email.timestamp)}
          </time>
          {isUnread && (
            <span
              className="h-2 w-2 rounded-full bg-primary"
              aria-label="Não lida"
            />
          )}
        </div>
      </header>

      <div className="grid gap-2 pb-2 pl-[60px] pr-4">
        {email.subject && (
          <p
            className={cn(
              "text-[13px]",
              isUnread
                ? "font-semibold text-text-primary"
                : "font-medium text-text-secondary",
            )}
          >
            {email.subject}
          </p>
        )}

        {email.cc && email.cc.length > 0 && (
          <CcChips cc={email.cc} internalDomains={internalDomains} />
        )}

        {email.bodyHtml ? (
          <EmailHtmlFrame
            html={email.bodyHtml}
            attachments={email.attachments}
            collapsedHeight={420}
            className="overflow-hidden rounded-[6px] border border-border"
          />
        ) : texto ? (
          <div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">
              {cortado ? texto.slice(0, LIMITE_TEXTO).trimEnd() + "…" : texto}
            </p>
            {texto.length > LIMITE_TEXTO && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                className="mt-1 text-xs font-medium text-primary-ink hover:underline"
              >
                {expanded ? "Mostrar menos" : "Mostrar tudo"}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm italic text-text-tertiary">(sem texto)</p>
        )}

        <AttachmentList attachments={email.attachments ?? []} />
      </div>

      {/* Ações sempre visíveis: "só no hover" escondia o Responder de quem usa toque. */}
      <footer className="flex flex-wrap items-center gap-0.5 border-t border-border-subtle px-2 py-1 pl-[52px]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReply(email.id);
          }}
          data-testid="message-reply"
          className={acao}
        >
          <ReplyIcon size={13} />
          {temRascunho ? "Continuar rascunho" : "Responder"}
        </button>
        {temRascunho && <RascunhoPill />}
        {email.bodyHtml && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className={acao}
            title="Ver a mensagem original em tela cheia"
          >
            <Maximize2 size={13} />
            Ver original
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void copyMessageLink(email.id);
          }}
          data-testid="message-copy-link"
          className={acao}
          title="Copiar link desta mensagem"
        >
          <Link2 size={13} />
          Copiar link
        </button>
        {onReassign && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReassign(email);
            }}
            data-testid="message-reassign"
            className={acao}
            title="Mover para outra pessoa"
          >
            <UserPen size={13} />
            Mover
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(email.id);
          }}
          className={cn(acao, "ml-auto hover:text-destructive")}
          title="Excluir mensagem"
        >
          <Trash2 size={13} />
          <span className="sr-only">Excluir</span>
        </button>
      </footer>
    </article>
  );
}
