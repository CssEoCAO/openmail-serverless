import { lazy, Suspense, useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ListOrdered, Reply, ShieldBan } from "lucide-react";
import {
  markEmailRead,
  markPeopleRead,
  deleteEmail,
  fetchPersonEnrollment,
  addBlock,
  type GroupedPerson,
  type Email,
  type InboxDisplayMode,
  type PersonEmailsResponse,
  type ReassignPersonResult,
} from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { messageDomId, readMessageHash } from "@/lib/message-link";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import { ehDominioGratuito } from "@/lib/dominios-gratuitos";
import ReassignPersonModal from "@/components/ReassignPersonModal";
import SequenceStatus from "@/components/SequenceStatus";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ThreadInboxSection, {
  type ThreadInboxGroup,
} from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";
import MarkAllReadButton from "@/components/MarkAllReadButton";
import Monograma from "@/components/Monograma";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { onEmailSent } from "@/lib/email-events";
import { showToast } from "@/lib/toast";
import {
  chaves,
  mapearPaginas,
  useEmailsPessoa,
  useStats,
} from "@/lib/queries";
import { dominioDe } from "@/lib/arvore-caixas";
import { plural } from "@/lib/datas";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
// O editor de resposta (Tiptap) só baixa quando alguém clica em Responder.
const ReplyComposer = lazy(() => import("@/components/ReplyComposer"));

interface PersonDetailProps {
  person: GroupedPerson;
  onEmailRead: (personId: string) => void;
  onEmailDelete: (personId: string, wasUnread: boolean) => void;
  /** "Abrir no editor completo" do chat: a bandeja de escrever já preenchida. */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
  /** Remetente (ou domínio) bloqueado: a conversa some da caixa. */
  onBlock?: () => void;
  /** Voltar à lista (celular). */
  onBack?: () => void;
  /** Caixa aberta na lista: a conversa abre na aba dela, se a pessoa escreveu lá. */
  caixaPreferida?: string;
}

function inboxOf(email: Email): string {
  return (
    (email.type === "received" ? email.recipient : email.fromAddress) ??
    "(desconhecida)"
  );
}

function groupEmailsByInbox(emails: Email[]): ThreadInboxGroup[] {
  const byInbox = new Map<string, Email[]>();
  for (const email of emails) {
    const key = inboxOf(email);
    const list = byInbox.get(key);
    if (list) list.push(email);
    else byInbox.set(key, [email]);
  }
  const groups: ThreadInboxGroup[] = [];
  for (const [inbox, list] of byInbox) {
    const latestReceivedTs =
      list.find((e) => e.type === "received")?.timestamp ?? 0;
    groups.push({
      inbox,
      emails: list,
      latestTimestamp: latestReceivedTs || (list[0]?.timestamp ?? 0),
    });
  }
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

function unreadIn(group: ThreadInboxGroup): number {
  return group.emails.filter((e) => e.type === "received" && e.isRead === 0)
    .length;
}

/** Só a parte antes do @: as abas mostram "contato", o endereço inteiro vai no title. */
function inboxLabel(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? email : email.slice(0, at);
}

export default function PersonDetail({
  person,
  onEmailRead,
  onEmailDelete,
  onOpenCompose,
  onBlock,
  onBack,
  caixaPreferida,
}: PersonDetailProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chave = chaves.emailsPessoa(person.id);
  const consulta = useEmailsPessoa(person.id);
  const { data: stats } = useStats();
  const inscricao = useQuery({
    queryKey: ["inscricao", person.id],
    queryFn: () => fetchPersonEnrollment(person.id),
  });

  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [reassignEmail, setReassignEmail] = useState<Email | null>(null);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const [expandedOlder, setExpandedOlder] = useState<Record<string, boolean>>(
    {},
  );
  const [activeInbox, setActiveInbox] = useState<string | null>(null);

  const emails = useMemo(
    () => consulta.data?.pages.flatMap((p) => p.emails) ?? [],
    [consulta.data],
  );
  const inboxModeMap = useMemo(() => {
    const m = new Map<string, InboxDisplayMode>();
    for (const p of consulta.data?.pages ?? [])
      for (const i of p.inboxes) m.set(i.email, i.displayMode);
    return m;
  }, [consulta.data]);
  const senderIdentities = stats?.senderIdentities ?? [];

  /** Muda as mensagens em cache, em todas as páginas já baixadas. */
  function mudarEmails(fn: (lista: Email[]) => Email[]) {
    qc.setQueryData(chave, (d: typeof consulta.data) =>
      mapearPaginas<PersonEmailsResponse>(d, (p) => ({
        ...p,
        emails: fn(p.emails),
      })),
    );
  }
  const recarregar = () => void qc.invalidateQueries({ queryKey: chave });

  async function handleBlock(type: "email" | "domain") {
    const email = person.email.toLowerCase();
    const value = type === "email" ? email : dominioDe(email);
    if (!value) return;
    try {
      await addBlock({ type, value });
      showToast({
        kind: "success",
        message: tx("{0} bloqueado", value),
        description:
          type === "domain"
            ? tx(
                "As conversas desse domínio somem da caixa, e o que chegar dele vai para o Spam (fica 30 dias).",
              )
            : tx(
                "As conversas desse endereço somem da caixa, e o que chegar dele vai para o Spam (fica 30 dias).",
              ),
        durationMs: 5000,
      });
      if (onBlock) onBlock();
      else navigate("/");
    } catch (err) {
      // A trava do servidor diz o motivo: endereço nosso, e-mail gratuito.
      const motivo = err instanceof Error ? err.message : "";
      showToast({
        kind: "error",
        message: tx("Não deu para bloquear"),
        description: motivo.startsWith("API error")
          ? tx("O servidor recusou o bloqueio.")
          : motivo,
      });
    }
  }

  async function handleMarkRead(email: Email) {
    if (email.type !== "received" || email.isRead !== 0) return;
    mudarEmails((l) =>
      l.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e)),
    );
    try {
      await markEmailRead(email.id, true);
      onEmailRead(person.id);
    } catch {
      recarregar();
    }
  }

  async function handleMarkInboxRead(inboxAddress: string) {
    mudarEmails((l) =>
      l.map((e) =>
        e.recipient === inboxAddress && e.type === "received" && e.isRead === 0
          ? { ...e, isRead: 1 }
          : e,
      ),
    );
    try {
      await markPeopleRead([person.id], inboxAddress);
      onEmailRead(person.id);
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
    const target = emails.find((e) => e.id === emailId);
    const wasUnread = target?.type === "received" && target.isRead === 0;
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
    onEmailDelete(person.id, wasUnread);
  }

  function handleReassignDone(result: ReassignPersonResult) {
    const moved = reassignEmail;
    if (moved) {
      const wasUnread = moved.type === "received" && moved.isRead === 0;
      // A mensagem agora é de outra pessoa: sai daqui como se fosse excluída.
      mudarEmails((l) => l.filter((e) => e.id !== moved.id));
      onEmailDelete(person.id, wasUnread);
      void qc.invalidateQueries({ queryKey: chaves.conversas });
    }
    const target = result.person?.email ?? result.email.toAddress;
    showToast({
      kind: "success",
      message: target
        ? tx("Movida para {0}", target)
        : "Mensagem redirecionada",
      description: result.person?.created
        ? tx("Criamos a pessoa e movemos a mensagem para ela.")
        : tx("As respostas a esta mensagem vão para ela."),
      durationMs: 5000,
    });
  }

  const inboxGroups = useMemo(() => groupEmailsByInbox(emails), [emails]);
  const distinctInboxes = useMemo(
    () => inboxGroups.map((g) => g.inbox).filter((i) => i !== "(desconhecida)"),
    [inboxGroups],
  );

  // Domínios nossos: o CC interno ganha outra cor.
  const internalDomains = useMemo(
    () => [...new Set(senderIdentities.map((s) => dominioDe(s.email)))],
    [senderIdentities],
  );

  // Abre na caixa que está aberta na lista; fora dela, na da mensagem mais recente.
  useEffect(() => {
    if (inboxGroups.length === 0) {
      setActiveInbox(null);
      return;
    }
    if (!activeInbox || !inboxGroups.find((g) => g.inbox === activeInbox)) {
      const preferida = caixaPreferida?.toLowerCase();
      setActiveInbox(
        inboxGroups.find((g) => g.inbox.toLowerCase() === preferida)?.inbox ??
          inboxGroups[0].inbox,
      );
    }
  }, [inboxGroups, activeInbox, caixaPreferida]);

  // Link para uma mensagem (#m=<id>): troca para a aba dela, abre as anteriores se
  // preciso, rola e pisca. Uma vez por (pessoa, hash).
  const location = useLocation();
  const lastHashHandled = useRef<string | null>(null);
  useEffect(() => {
    if (emails.length === 0) return;
    const targetEmailId = readMessageHash(location.hash);
    if (!targetEmailId) return;
    const key = `${person.id}:${targetEmailId}`;
    if (lastHashHandled.current === key) return;
    const target = emails.find((e) => e.id === targetEmailId);
    if (!target) return;
    lastHashHandled.current = key;

    const targetInbox = inboxOf(target);
    setActiveInbox(targetInbox);
    const group = inboxGroups.find((g) => g.inbox === targetInbox);
    if (group && group.emails[0]?.id !== target.id) {
      setExpandedOlder((prev) =>
        prev[targetInbox] ? prev : { ...prev, [targetInbox]: true },
      );
    }
    // Dois quadros: um para a troca de aba entrar, outro para a mensagem existir.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(messageDomId(target.id));
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("message-link-flash");
        void el.offsetWidth;
        el.classList.add("message-link-flash");
        window.setTimeout(
          () => el.classList.remove("message-link-flash"),
          2400,
        );
      });
    });
  }, [emails, location.hash, inboxGroups, person.id]);

  // Resposta enviada de outra caixa que não a aba aberta: troca de aba e avisa,
  // senão a mensagem cai numa aba que ninguém está olhando.
  useEffect(() => {
    const off = onEmailSent((detail) => {
      const sentInbox = detail.fromAddress;
      if (!distinctInboxes.includes(sentInbox)) return;
      const previous = activeInbox;
      if (previous && previous !== sentInbox) {
        setActiveInbox(sentInbox);
        showToast({
          kind: "info",
          message: tx("Resposta saiu por {0}", inboxLabel(sentInbox)),
          description: tx(
            "Você estava em {0}; trocamos de aba para mostrar.",
            inboxLabel(previous),
          ),
          durationMs: 5500,
        });
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInbox, distinctInboxes.join("|")]);

  const activeGroup =
    inboxGroups.find((g) => g.inbox === activeInbox) ?? inboxGroups[0] ?? null;
  const modo = activeGroup
    ? (inboxModeMap.get(activeGroup.inbox) ?? "chat")
    : "chat";
  const ultimaRecebida =
    activeGroup?.emails.find((e) => e.type === "received") ?? null;

  const replyInboxForEmail = (email: Email) => {
    const ib = inboxOf(email);
    return ib === "(desconhecida)" ? distinctInboxes : [ib];
  };

  const cabecalho = (
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
      <Monograma nome={person.name} email={person.email} />
      <div className="min-w-0 flex-[1_1_200px]">
        <h2 className="truncate text-base font-semibold text-text-primary">
          {person.name || person.email}
        </h2>
        <p className="truncate text-xs text-text-tertiary">
          {person.name ? `${person.email} · ` : ""}
          {plural(person.totalCount, "mensagem", "mensagens")}
          {inboxGroups.length > 1
            ? tx(" · {0} caixas", inboxGroups.length)
            : distinctInboxes[0]
              ? ` · ${distinctInboxes[0]}`
              : ""}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {activeGroup && (
          <MarkAllReadButton
            unreadCount={unreadIn(activeGroup)}
            scopeLabel={activeGroup.inbox}
            onMarkAllRead={() => handleMarkInboxRead(activeGroup.inbox)}
          />
        )}
        {inscricao.data?.enrollment ? (
          <SequenceStatus
            info={inscricao.data}
            onStatusChange={() =>
              void qc.invalidateQueries({ queryKey: ["inscricao", person.id] })
            }
          />
        ) : (
          <button
            type="button"
            onClick={() => setEnrollModalOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-subtle hover:text-text-primary"
          >
            <ListOrdered size={14} />
            {tx("Sequência")}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={tx("Bloquear remetente")}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-xs font-medium text-text-secondary hover:border-destructive/40 hover:text-destructive"
            >
              <ShieldBan size={14} />
              {tx("Bloquear")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onClick={() => handleBlock("email")}>
              {tx("Bloquear")} {person.email}
            </DropdownMenuItem>
            {/* Domínio de e-mail gratuito é de muita gente: só o endereço. */}
            {!ehDominioGratuito(dominioDe(person.email)) && (
              <DropdownMenuItem onClick={() => handleBlock("domain")}>
                {tx("Bloquear o domínio")} {dominioDe(person.email)}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );

  if (consulta.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {cabecalho}
        <div className="grid gap-3 p-4" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="h-24 rounded-[6px] bg-bg-muted/70" />
          ))}
        </div>
      </div>
    );
  }

  if (consulta.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {cabecalho}
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
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {cabecalho}

      {/* Uma aba por caixa (só a parte antes do @); o endereço inteiro no title. */}
      {inboxGroups.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden border-b border-border px-3 [scrollbar-width:none]">
          {inboxGroups.map((group) => {
            const unread = unreadIn(group);
            const isActive = activeGroup?.inbox === group.inbox;
            return (
              <button
                key={group.inbox}
                type="button"
                data-testid="inbox-tab"
                onClick={() => setActiveInbox(group.inbox)}
                title={group.inbox}
                aria-pressed={isActive}
                className={cn(
                  "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs transition-colors",
                  isActive
                    ? "border-primary font-semibold text-text-primary"
                    : "border-transparent text-text-tertiary hover:text-text-primary",
                )}
              >
                {inboxLabel(group.inbox)}
                <span className="tabular-nums text-text-tertiary">
                  {group.emails.length}
                </span>
                {unread > 0 && (
                  <span
                    className="tabular-nums font-semibold text-primary-ink"
                    aria-label={tx("{0} não lidas", unread)}
                  >
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

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
        {activeGroup ? (
          modo === "chat" ? (
            <ChatInboxSection
              key={activeGroup.inbox}
              group={activeGroup}
              personEmail={person.email}
              internalDomains={internalDomains}
              onOpenHtml={setHtmlPreviewEmail}
              onMarkRead={handleMarkRead}
              onDelete={handleDelete}
              onReassign={setReassignEmail}
              onReply={setReplyToEmailId}
              onSent={recarregar}
              onOpenCompose={onOpenCompose}
            />
          ) : (
            <>
              <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto bg-bg-subtle">
                <ThreadInboxSection
                  key={activeGroup.inbox}
                  group={activeGroup}
                  personEmail={person.email}
                  personName={person.name}
                  internalDomains={internalDomains}
                  isOlderExpanded={!!expandedOlder[activeGroup.inbox]}
                  onToggleOlder={() =>
                    setExpandedOlder((prev) => ({
                      ...prev,
                      [activeGroup.inbox]: !prev[activeGroup.inbox],
                    }))
                  }
                  onOpenHtml={setHtmlPreviewEmail}
                  onMarkRead={handleMarkRead}
                  onReply={setReplyToEmailId}
                  onDelete={handleDelete}
                  onReassign={setReassignEmail}
                />
              </div>
              {ultimaRecebida && (
                <div className="shrink-0 border-t border-border bg-card px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setReplyToEmailId(ultimaRecebida.id)}
                    className="flex h-10 w-full items-center gap-2 rounded-[6px] border border-border px-3 text-left text-sm text-text-tertiary hover:border-primary/50 hover:text-text-secondary"
                  >
                    <Reply size={15} />
                    {tx("Responder para")} {person.name || person.email}…
                  </button>
                </div>
              )}
            </>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
            {tx("Nenhuma mensagem.")}
          </div>
        )}
      </div>

      {replyToEmailId && (
        <Suspense fallback={null}>
          <ReplyComposer
            emailId={replyToEmailId}
            personName={person.name}
            personEmail={person.email}
            recipients={(() => {
              const target = emails.find((e) => e.id === replyToEmailId);
              return target ? replyInboxForEmail(target) : distinctInboxes;
            })()}
            senderIdentities={senderIdentities}
            internalDomains={internalDomains}
            onClose={() => setReplyToEmailId(null)}
            onSent={recarregar}
          />
        </Suspense>
      )}

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

      <ReassignPersonModal
        email={reassignEmail}
        currentSender={person.name || person.email}
        open={reassignEmail !== null}
        onClose={() => setReassignEmail(null)}
        onDone={handleReassignDone}
      />

      <EnrollSequenceModal
        personId={person.id}
        personName={person.name}
        personEmail={person.email}
        recipients={distinctInboxes}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={() =>
          void qc.invalidateQueries({ queryKey: ["inscricao", person.id] })
        }
      />
    </div>
  );
}
