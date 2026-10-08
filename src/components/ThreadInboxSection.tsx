import { Fragment, useState } from "react";
import MessageBubble, {
  remetenteDe,
  textoDe,
} from "@/components/MessageBubble";
import Monograma from "@/components/Monograma";
import { RosterDiffNotice } from "@/components/CcChips";
import { rosterOf } from "@/lib/roster";
import { messageDomId } from "@/lib/message-link";
import { dataHora } from "@/lib/datas";
import type { Email } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ThreadInboxGroup {
  inbox: string;
  emails: Email[]; // da mais nova para a mais antiga
  latestTimestamp: number;
}

interface ThreadInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  personName?: string | null;
  internalDomains?: string[];
  /** Remetente por mensagem (conversa em grupo). */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  /** Abre todas as anteriores de uma vez (link para uma mensagem antiga). */
  isOlderExpanded: boolean;
  onToggleOlder: () => void;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
}

/**
 * Modo fio, como no Gmail: a mais recente aberta embaixo, as anteriores em uma
 * linha cada (quem mandou, começo do texto, data). Clicar numa linha abre só ela.
 */
export default function ThreadInboxSection({
  group,
  personEmail,
  personName,
  internalDomains = [],
  senderResolver,
  isOlderExpanded,
  onToggleOlder,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onReassign,
}: ThreadInboxSectionProps) {
  const [abertas, setAbertas] = useState<Set<string>>(new Set());
  const latest = group.emails[0];
  const anteriores = group.emails.slice(1).reverse();
  const aberta = (e: Email) =>
    isOlderExpanded ||
    abertas.has(e.id) ||
    (e.type === "received" && e.isRead === 0);

  const bolha = (email: Email) => (
    <MessageBubble
      email={email}
      personEmail={personEmail}
      personName={personName}
      internalDomains={internalDomains}
      senderResolver={senderResolver}
      onOpenHtml={onOpenHtml}
      onMarkRead={onMarkRead}
      onReply={onReply}
      onDelete={onDelete}
      onReassign={onReassign}
    />
  );

  return (
    <section
      className="grid grid-cols-[minmax(0,1fr)] gap-2 px-3 py-4 sm:px-5"
      aria-label={group.inbox}
    >
      {anteriores.length > 1 && (
        <button
          type="button"
          onClick={onToggleOlder}
          className="justify-self-start rounded-[6px] px-2 py-1 text-xs font-medium text-primary-ink hover:bg-primary-soft"
        >
          {isOlderExpanded
            ? "Recolher as anteriores"
            : `Abrir as ${anteriores.length} anteriores`}
        </button>
      )}
      {anteriores.map((email, idx) => {
        const prev = anteriores[idx - 1];
        if (!aberta(email)) {
          const de = remetenteDe(
            email,
            personEmail,
            personName,
            senderResolver,
          );
          return (
            <button
              key={email.id}
              id={messageDomId(email.id)}
              type="button"
              onClick={() => setAbertas((s) => new Set(s).add(email.id))}
              className="flex min-w-0 items-center gap-3 rounded-[6px] border border-border bg-card px-4 py-2.5 text-left hover:border-text-tertiary/40"
            >
              <Monograma
                nome={de.nome}
                email={de.email}
                className="h-7 w-7 text-[10px]"
              />
              <span className="shrink-0 text-[13px] font-semibold text-text-primary">
                {de.nome}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-text-tertiary">
                {textoDe(email).replace(/\s+/g, " ").trim() ||
                  email.subject ||
                  "(sem texto)"}
              </span>
              <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
                {dataHora(email.timestamp)}
              </span>
            </button>
          );
        }
        return (
          <Fragment key={email.id}>
            {prev && aberta(prev) && (
              <RosterDiffNotice
                prev={rosterOf(prev, senderResolver)}
                next={rosterOf(email, senderResolver)}
                internalDomains={internalDomains}
              />
            )}
            {bolha(email)}
          </Fragment>
        );
      })}
      {latest && (
        <div className={cn(anteriores.length > 0 && "mt-1")}>
          {anteriores.length > 0 &&
            aberta(anteriores[anteriores.length - 1]) && (
              <RosterDiffNotice
                prev={rosterOf(
                  anteriores[anteriores.length - 1],
                  senderResolver,
                )}
                next={rosterOf(latest, senderResolver)}
                internalDomains={internalDomains}
              />
            )}
          {bolha(latest)}
        </div>
      )}
    </section>
  );
}
