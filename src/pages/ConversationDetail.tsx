import { lazy, Suspense, useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Users } from "lucide-react";
import MarkAllReadButton from "@/components/MarkAllReadButton";
import {
  markEmailRead,
  markConversationsRead,
  deleteEmail,
  type GroupedConversation,
  type Email,
  type ConversationDetail as ConversationDetailData,
} from "@/lib/api";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import { type ThreadInboxGroup } from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";
import { nomesDoGrupo } from "@/components/GroupRow";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { onEmailSent } from "@/lib/email-events";
import { showToast } from "@/lib/toast";
import { chaves, mapearPaginas, useConversa, useStats } from "@/lib/queries";
import { plural } from "@/lib/datas";

import { tx } from "@/lib/i18n";
const ReplyComposer = lazy(() => import("@/components/ReplyComposer"));

interface ConversationDetailProps {
  conversation: GroupedConversation;
  /** Domínios nossos, para colorir o CC interno. */
  internalDomains?: string[];
  /** "Abrir no editor completo" do chat. */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
  /** Voltar à lista (celular). */
  onBack?: () => void;
}

function inboxLabel(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? email : email.slice(0, at);
}

/**
 * Conversa com 2+ participantes de fora: cada mensagem mostra quem mandou. Uma
 * conversa é de uma caixa só (é assim que os grupos se formam), então não tem abas.
 * Sempre no modo chat: ida e volta entre várias pessoas lê melhor em balões.
 */
export default function ConversationDetail({
  conversation,
  internalDomains = [],
  onOpenCompose,
  onBack,
}: ConversationDetailProps) {
  const qc = useQueryClient();
  const chave = chaves.conversa(conversation.id);
  const consulta = useConversa(conversation.id);
  const { data: stats } = useStats();
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  // Responder a UMA mensagem do grupo: sai pela caixa do grupo, para quem escreveu.
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  // Página 1 é a mais nova e cada página vem em ordem de tempo: inverte as páginas.
  const emails = useMemo(
    () =>
      consulta.data
        ? [...consulta.data.pages].reverse().flatMap((p) => p.emails)
        : [],
    [consulta.data],
  );

  function mudarEmails(fn: (lista: Email[]) => Email[]) {
    qc.setQueryData(chave, (d: typeof consulta.data) =>
      mapearPaginas<ConversationDetailData>(d, (p) => ({
        ...p,
        emails: fn(p.emails),
      })),
    );
  }
  const recarregar = () => void qc.invalidateQueries({ queryKey: chave });

  // Resposta saiu por outra caixa: em grupo isso abre outra conversa. Avisa.
  useEffect(
    () =>
      onEmailSent((detail) => {
        if (
          detail.fromAddress.toLowerCase() !== conversation.inbox.toLowerCase()
        ) {
          showToast({
            kind: "warning",
            message: tx(
              "A resposta saiu por {0}",
              inboxLabel(detail.fromAddress),
            ),
            description: tx(
              "Esta conversa é de {0}; resposta por outra caixa começa outra conversa.",
              inboxLabel(conversation.inbox),
            ),
            durationMs: 6500,
          });
        }
      }),
    [conversation.inbox],
  );

  async function handleMarkRead(email: Email) {
    if (email.type !== "received" || email.isRead !== 0) return;
    mudarEmails((l) =>
      l.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e)),
    );
    try {
      await markEmailRead(email.id, true);
      void qc.invalidateQueries({ queryKey: chaves.stats });
      void qc.invalidateQueries({ queryKey: chaves.conversas });
    } catch {
      recarregar();
    }
  }

  async function marcarTudo() {
    mudarEmails((l) =>
      l.map((e) =>
        e.type === "received" && e.isRead === 0 ? { ...e, isRead: 1 } : e,
      ),
    );
    try {
      await markConversationsRead([conversation.id]);
      void qc.invalidateQueries({ queryKey: chaves.stats });
      void qc.invalidateQueries({ queryKey: chaves.conversas });
    } catch {
      recarregar();
    }
  }

  async function handleDelete(emailId: string) {
    if (
      !confirm(
        tx(
          "Excluir esta mensagem e os anexos para sempre? Não dá para desfazer.",
        ),
      )
    )
      return;
    try {
      await deleteEmail(emailId);
    } catch {
      showToast({
        kind: "error",
        message: tx("Não deu para excluir a mensagem"),
      });
      return;
    }
    mudarEmails((l) => l.filter((e) => e.id !== emailId));
  }

  // ChatInboxSection espera uma caixa com as mensagens da mais nova para a mais antiga.
  const group: ThreadInboxGroup = useMemo(() => {
    const newestFirst = [...emails].reverse();
    return {
      inbox: conversation.inbox,
      emails: newestFirst,
      latestTimestamp: newestFirst[0]?.timestamp ?? 0,
    };
  }, [emails, conversation.inbox]);

  const senderById = useMemo(() => {
    const m = new Map<string, { email: string; name: string | null }>();
    for (const p of conversation.participants)
      m.set(p.id, { email: p.email, name: p.name });
    return m;
  }, [conversation.participants]);

  const totalUnread = emails.filter(
    (e) => e.type === "received" && e.isRead === 0,
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={tx("Voltar à lista")}
            className="-ml-1 flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-text-primary/[0.05] md:hidden"
          >
            <ArrowLeft size={17} />
          </button>
        )}
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
          <Users size={15} />
        </span>
        <div className="min-w-0 flex-[1_1_200px]">
          <h2
            className="truncate text-base font-semibold text-text-primary"
            title={conversation.participants.map((p) => p.email).join(", ")}
          >
            {nomesDoGrupo(conversation.participants)}
          </h2>
          <p className="truncate text-xs text-text-tertiary">
            {conversation.inbox} ·{" "}
            {plural(
              conversation.participants.length,
              "participante",
              "participantes",
            )}{" "}
            · {plural(conversation.totalCount, "mensagem", "mensagens")}
          </p>
        </div>
        <MarkAllReadButton
          unreadCount={totalUnread}
          scopeLabel={conversation.inbox}
          onMarkAllRead={marcarTudo}
        />
      </header>

      {consulta.hasNextPage && (
        <button
          type="button"
          onClick={() => void consulta.fetchNextPage()}
          disabled={consulta.isFetchingNextPage}
          className="shrink-0 border-b border-border py-1.5 text-xs font-medium text-primary-ink hover:bg-bg-subtle disabled:opacity-60"
        >
          {consulta.isFetchingNextPage
            ? tx("Carregando…")
            : tx("Mostrar mensagens mais antigas")}
        </button>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {consulta.isPending ? (
          <div className="grid gap-3 p-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`h-14 w-2/3 rounded-[12px] bg-bg-muted/70 ${i === 1 ? "justify-self-end" : ""}`}
              />
            ))}
          </div>
        ) : consulta.isError ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-text-primary">
              {tx("Não deu para abrir a conversa.")}
            </p>
            <button
              type="button"
              onClick={() => void consulta.refetch()}
              className="mt-2 text-sm font-medium text-primary-ink hover:underline"
            >
              {tx("Tentar de novo")}
            </button>
          </div>
        ) : (
          <ChatInboxSection
            key={conversation.id}
            group={group}
            personEmail={conversation.participants[0]?.email ?? ""}
            internalDomains={internalDomains}
            senderResolver={(e) => {
              if (e.type === "sent") return null;
              if (e.personId) {
                const r = senderById.get(e.personId);
                if (r) return r;
              }
              return e.fromAddress
                ? { email: e.fromAddress, name: null }
                : null;
            }}
            onOpenHtml={setHtmlPreviewEmail}
            onMarkRead={handleMarkRead}
            onDelete={handleDelete}
            onReply={setReplyToEmailId}
            onSent={recarregar}
            onOpenCompose={onOpenCompose}
          />
        )}
      </div>

      {replyToEmailId &&
        (() => {
          const alvo = emails.find((e) => e.id === replyToEmailId);
          const quem =
            (alvo?.personId ? senderById.get(alvo.personId) : null) ??
            (alvo?.type === "received" && alvo.fromAddress
              ? { email: alvo.fromAddress, name: null }
              : null) ??
            conversation.participants[0] ??
            null;
          return (
            <Suspense fallback={null}>
              <ReplyComposer
                emailId={replyToEmailId}
                personName={quem?.name ?? null}
                personEmail={quem?.email ?? ""}
                recipients={[conversation.inbox]}
                senderIdentities={stats?.senderIdentities ?? []}
                internalDomains={internalDomains}
                onClose={() => setReplyToEmailId(null)}
                onSent={recarregar}
              />
            </Suspense>
          );
        })()}

      <EmailHtmlModal
        email={htmlPreviewEmail}
        open={htmlPreviewEmail !== null}
        onClose={() => setHtmlPreviewEmail(null)}
        onUpdated={recarregar}
        onReply={(id) => {
          setHtmlPreviewEmail(null);
          setReplyToEmailId(id);
        }}
      />
    </div>
  );
}
