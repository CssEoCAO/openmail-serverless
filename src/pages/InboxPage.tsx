import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useOutletContext,
  useSearchParams,
} from "react-router-dom";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import type { ShellContext } from "@/components/AppShell";
import PersonList from "./PersonList";
import PersonDetail from "./PersonDetail";
import ConversationDetail from "./ConversationDetail";
import ListHeader, {
  type InboxFilters,
  type InboxView,
} from "@/components/ListHeader";
import PeopleTable from "@/components/PeopleTable";
import AgentPlan from "@/components/AgentPlan";
import SelectionBar from "@/components/SelectionBar";
import {
  addBlock,
  fetchPerson,
  markPeopleRead,
  markConversationsRead,
  type GroupedItem,
  type GroupedPerson,
  type GroupedConversation,
  type InboxSortSpec,
  type PaginatedGroupedPeople,
} from "@/lib/api";
import {
  chaves,
  lerOrdem,
  opcoesLista,
  POR_PAGINA_LISTA,
  useStats,
} from "@/lib/queries";
import { rotuloCaixa, dominioDe } from "@/lib/arvore-caixas";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
/** Espera o usuário parar de digitar; o resto da lista responde na hora. */
function useAtrasado<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export default function InboxPage() {
  const outlet = useOutletContext<ShellContext | null>();
  const onCompose = outlet?.onCompose ?? (() => {});
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const { data: stats } = useStats();

  const [selectedPerson, setSelectedPerson] = useState<GroupedPerson | null>(
    null,
  );
  const [selectedConversation, setSelectedConversation] =
    useState<GroupedConversation | null>(null);

  // A caixa vem da ROTA: recarregar, compartilhar o link e voltar pelo histórico
  // mantêm a caixa. "todas" é sentinela segura, todo endereço real tem "@".
  const { inbox: routeInbox, personId: routePersonId } = useParams<{
    inbox: string;
    personId: string;
  }>();
  const caixaDaRota =
    routeInbox && routeInbox !== "todas"
      ? decodeURIComponent(routeInbox)
      : undefined;

  const [filters, setFilters] = useState<InboxFilters>(() => ({
    recipient: caixaDaRota,
  }));
  useEffect(() => {
    setFilters((f) =>
      f.recipient === caixaDaRota ? f : { ...f, recipient: caixaDaRota },
    );
  }, [caixaDaRota]);

  // `/?q=` e `/?search=` são links já publicados (admin externo): chegam filtrados.
  const [search, setSearch] = useState(
    () => searchParams.get("q") ?? searchParams.get("search") ?? "",
  );
  const busca = useAtrasado(search, 250);
  const [view, setView] = useState<InboxView>("list");
  const [sortSpec, setSortSpec] = useState<InboxSortSpec>(lerOrdem);
  useEffect(() => {
    try {
      window.localStorage?.setItem(
        "saasmail.inboxSort",
        JSON.stringify(sortSpec),
      );
    } catch {
      /* sem armazenamento: a ordem vale só nesta aba */
    }
  }, [sortSpec]);

  const [peoplePage, setPeoplePage] = useState(1);
  // Volta para a página 1 quando o que se busca muda (inverter a ordem mantém a
  // página: quem inverte quer olhar a mesma janela).
  useEffect(() => {
    setPeoplePage(1);
  }, [
    busca,
    filters.recipient,
    filters.unread,
    filters.hasAttachment,
    sortSpec.key,
  ]);

  const peopleQuery = useMemo(
    () => ({
      q: busca || undefined,
      recipient: filters.recipient,
      unread: filters.unread,
      hasAttachment: filters.hasAttachment,
      sort: sortSpec.key,
      direction: sortSpec.direction,
      page: peoplePage,
      limit: POR_PAGINA_LISTA,
    }),
    [
      busca,
      filters.recipient,
      filters.unread,
      filters.hasAttachment,
      sortSpec.key,
      sortSpec.direction,
      peoplePage,
    ],
  );
  const consulta = useMemo(() => opcoesLista(peopleQuery), [peopleQuery]);
  const chaveLista = consulta.queryKey;

  const lista = useQuery({
    ...consulta,
    // Trocar de caixa mantém a lista anterior (apagada) até a nova chegar, em vez
    // de piscar "Carregando…".
    placeholderData: keepPreviousData,
  });
  const items: GroupedItem[] = lista.data?.data ?? [];
  const peopleTotal = lista.data?.total ?? 0;

  /** Atualiza a lista em cache (otimista) sem esperar o servidor. */
  const mudarLista = useCallback(
    (fn: (itens: GroupedItem[]) => GroupedItem[]) => {
      qc.setQueryData<PaginatedGroupedPeople>(chaveLista, (d) =>
        d ? { ...d, data: fn(d.data) } : d,
      );
    },
    [qc, chaveLista],
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedConversationIds, setSelectedConversationIds] = useState<
    Set<string>
  >(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectedConversation = useCallback((id: string) => {
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Marca ou desmarca todas as linhas da página (pessoas e grupos de uma vez).
  const toggleSelectAll = useCallback(() => {
    const persons = items.filter(
      (it): it is GroupedPerson => it.type === "person",
    );
    const groups = items.filter(
      (it): it is GroupedConversation => it.type === "group",
    );
    const allOn =
      persons.every((p) => selectedIds.has(p.id)) &&
      groups.every((g) => selectedConversationIds.has(g.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of persons) {
        if (allOn) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      for (const g of groups) {
        if (allOn) next.delete(g.id);
        else next.add(g.id);
      }
      return next;
    });
  }, [items, selectedIds, selectedConversationIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedConversationIds(new Set());
  }, []);

  // Marcar como lida: zera na hora, chama a API e desfaz se ela falhar.
  async function applyMarkRead(personIds: string[], conversationIds: string[]) {
    if (personIds.length === 0 && conversationIds.length === 0) return;
    setBulkBusy(true);
    const antes = qc.getQueryData<PaginatedGroupedPeople>(chaveLista);
    mudarLista((itens) =>
      itens.map((it) =>
        (it.type === "person" && personIds.includes(it.id)) ||
        (it.type === "group" && conversationIds.includes(it.id))
          ? { ...it, unreadCount: 0 }
          : it,
      ),
    );
    try {
      await Promise.all([
        personIds.length > 0 ? markPeopleRead(personIds) : undefined,
        conversationIds.length > 0
          ? markConversationsRead(conversationIds)
          : undefined,
      ]);
      void qc.invalidateQueries({ queryKey: chaves.stats });
      void qc.invalidateQueries({ queryKey: ["emails-pessoa"] });
      void qc.invalidateQueries({ queryKey: ["conversa"] });
    } catch {
      qc.setQueryData(chaveLista, antes);
    } finally {
      setBulkBusy(false);
    }
  }

  function handleBulkMarkRead() {
    applyMarkRead(Array.from(selectedIds), Array.from(selectedConversationIds));
    clearSelection();
  }

  const recarregarLista = useCallback(
    () => qc.invalidateQueries({ queryKey: chaves.conversas }),
    [qc],
  );

  const handleBlockSelected = useCallback(async () => {
    const emails = items
      .filter((it) => it.type === "person" && selectedIds.has(it.id))
      .map((it) => (it as GroupedPerson).email.toLowerCase());
    if (emails.length === 0) return;
    await Promise.all(
      emails.map((value) => addBlock({ type: "email", value }).catch(() => {})),
    );
    clearSelection();
    await recarregarLista();
  }, [items, selectedIds, clearSelection, recarregarLista]);

  // Estado → URL: abrir e fechar conversa reescreve /inbox/<caixa>[/<pessoa>], então
  // recarregar ou copiar o link devolve a mesma tela. Só reage a MUDANÇA do id: no
  // primeiro render a pessoa da rota ainda não carregou, e apagar o /<pessoa> ali
  // mataria o link direto. `replace` para não encher o histórico a cada clique.
  const idAnterior = useRef<string | null>(null);
  const idSelecionado = selectedPerson?.id ?? null;
  useEffect(() => {
    if (idSelecionado === idAnterior.current) return;
    idAnterior.current = idSelecionado;
    const base = `/inbox/${encodeURIComponent(caixaDaRota ?? "todas")}`;
    const alvo = idSelecionado ? `${base}/${idSelecionado}` : base;
    if (alvo !== location.pathname) {
      navigate(alvo + location.search, { replace: true });
    }
  }, [
    idSelecionado,
    caixaDaRota,
    location.pathname,
    location.search,
    navigate,
  ]);

  // Trocar de caixa pela lateral troca a rota; a conversa aberta é de outra caixa.
  const caixaAnterior = useRef(caixaDaRota);
  useEffect(() => {
    if (caixaAnterior.current === caixaDaRota) return;
    caixaAnterior.current = caixaDaRota;
    if (!routePersonId) {
      setSelectedPerson(null);
      setSelectedConversation(null);
    }
    clearSelection();
  }, [caixaDaRota, routePersonId, clearSelection]);

  // Pessoa da rota (link de notificação push ou recarga): usa a da lista se já
  // estiver nela; senão busca a pessoa direto para abrir a conversa mesmo assim.
  const lastProcessedPersonId = useRef<string | null>(null);
  useEffect(() => {
    if (!routePersonId) return;
    if (lastProcessedPersonId.current === routePersonId) return;
    if (selectedPerson?.id === routePersonId) {
      lastProcessedPersonId.current = routePersonId;
      return;
    }
    lastProcessedPersonId.current = routePersonId;
    const found = items.find(
      (it): it is GroupedPerson =>
        it.type === "person" && it.id === routePersonId,
    );
    if (found) {
      setSelectedPerson(found);
      return;
    }
    let cancelled = false;
    fetchPerson(routePersonId)
      .then((p) => {
        if (cancelled) return;
        setSelectedPerson({
          type: "person",
          id: p.id,
          email: p.email,
          name: p.name,
          lastEmailAt: p.lastEmailAt,
          unreadCount: p.unreadCount,
          totalCount: p.totalCount,
          // /api/people/:id não traz estes dois; o PersonDetail só precisa do id.
          recipientCount: 1,
          recipients: [],
          hasAttachment: 0,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [routePersonId, items, selectedPerson?.id]);

  function handleEmailRead(personId: string) {
    mudarLista((itens) =>
      itens.map((it) =>
        it.type === "person" && it.id === personId
          ? { ...it, unreadCount: Math.max(0, it.unreadCount - 1) }
          : it,
      ),
    );
    void qc.invalidateQueries({ queryKey: chaves.stats });
  }

  // O remetente (ou o domínio dele) acabou de ser bloqueado: a conversa some da caixa.
  function handlePersonBlocked() {
    setSelectedPerson(null);
    void recarregarLista();
  }

  function handleEmailDelete(personId: string, wasUnread: boolean) {
    mudarLista((itens) =>
      itens.map((it) =>
        it.type === "person" && it.id === personId
          ? {
              ...it,
              totalCount: Math.max(0, it.totalCount - 1),
              unreadCount: wasUnread
                ? Math.max(0, it.unreadCount - 1)
                : it.unreadCount,
            }
          : it,
      ),
    );
    void qc.invalidateQueries({ queryKey: chaves.stats });
  }

  const internalDomains = useMemo(
    () => (stats?.inboxes ?? []).map((s) => dominioDe(s.email)),
    [stats?.inboxes],
  );

  const caixaInfo = caixaDaRota
    ? stats?.inboxes.find((i) => i.email === caixaDaRota)
    : undefined;
  const titulo = caixaDaRota
    ? rotuloCaixa(caixaInfo ?? { email: caixaDaRota, displayName: null })
    : tx("Todas as caixas");

  if (stats && stats.inboxes.length === 0 && !isAdmin) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <h2 className="text-base font-semibold text-text-primary">
            {tx("Nenhuma caixa liberada para você")}
          </h2>
          <p className="mt-1 text-sm text-text-tertiary">
            {tx("Peça a um administrador para dar acesso a uma caixa.")}
          </p>
        </div>
      </div>
    );
  }

  // `?view=agent-plan`: a ferramenta WebMCP `visualize_plan` navega para cá.
  if (searchParams.get("view") === "agent-plan") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentPlan />
      </div>
    );
  }

  const aberta = !!(selectedPerson || selectedConversation);
  const temSelecao = selectedIds.size > 0 || selectedConversationIds.size > 0;
  const abrirPessoa = (p: GroupedPerson) => {
    setSelectedConversation(null);
    setSelectedPerson(p);
  };
  const abrirConversa = (c: GroupedConversation) => {
    setSelectedPerson(null);
    setSelectedConversation(c);
  };
  const fechar = () => {
    setSelectedPerson(null);
    setSelectedConversation(null);
  };

  const cabecalho = (
    <ListHeader
      titulo={titulo}
      endereco={caixaDaRota}
      naoLidas={lista.data?.aggregates.totalUnreadEmails ?? 0}
      conversas={lista.data ? peopleTotal : null}
      filters={filters}
      onFiltersChange={setFilters}
      search={search}
      onSearchChange={setSearch}
      view={view}
      onViewChange={(v) => {
        setView(v);
        fechar();
        clearSelection();
      }}
      sortSpec={sortSpec}
      onSortChange={setSortSpec}
      onRefresh={() => void lista.refetch()}
      refreshing={lista.isFetching && !lista.isPending}
    />
  );

  const barraSelecao = temSelecao && !aberta && (
    <SelectionBar
      count={selectedIds.size + selectedConversationIds.size}
      busy={bulkBusy}
      onMarkRead={handleBulkMarkRead}
      onBlock={handleBlockSelected}
      onClear={clearSelection}
      className="mx-3 my-2"
    />
  );

  const leitura = selectedConversation ? (
    <ConversationDetail
      key={selectedConversation.id}
      conversation={selectedConversation}
      internalDomains={internalDomains}
      onOpenCompose={onCompose}
      onBack={fechar}
    />
  ) : selectedPerson ? (
    <PersonDetail
      key={selectedPerson.id}
      person={selectedPerson}
      onEmailRead={handleEmailRead}
      onEmailDelete={handleEmailDelete}
      onOpenCompose={onCompose}
      onBlock={handlePersonBlocked}
      onBack={fechar}
    />
  ) : null;

  if (view === "table") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card">
        {aberta ? (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
              <button
                onClick={fechar}
                className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary hover:bg-text-primary/[0.05] hover:text-text-primary"
              >
                <ArrowLeft size={14} />
                {tx("Voltar à tabela")}
              </button>
            </div>
            <div className="min-h-0 flex-1">{leitura}</div>
          </>
        ) : (
          <>
            {cabecalho}
            {barraSelecao}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <PeopleTable
                items={items}
                onSelectPerson={abrirPessoa}
                onSelectConversation={abrirConversa}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                selectedConversationIds={selectedConversationIds}
                onToggleSelectedConversation={toggleSelectedConversation}
                onToggleSelectAll={toggleSelectAll}
                onMarkPersonRead={(id) => applyMarkRead([id], [])}
                onMarkConversationRead={(id) => applyMarkRead([], [id])}
                sortSpec={sortSpec}
                onSortChange={setSortSpec}
                total={peopleTotal}
                page={peoplePage}
                pageSize={POR_PAGINA_LISTA}
                onPageChange={setPeoplePage}
                aggregates={
                  lista.data?.aggregates ?? {
                    unreadRowCount: 0,
                    attachmentRowCount: 0,
                    multiInboxRowCount: 0,
                    totalUnreadEmails: 0,
                  }
                }
              />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Lista: no celular ocupa a tela e some quando uma conversa abre. */}
      <section
        aria-label={tx("Conversas")}
        className={cn(
          "min-h-0 w-full flex-col border-r border-border bg-card md:flex md:w-[340px] md:shrink-0 xl:w-[380px]",
          aberta ? "hidden" : "flex",
        )}
      >
        {cabecalho}
        {barraSelecao}
        <PersonList
          items={items}
          onDelete={(id) =>
            mudarLista((itens) =>
              itens.filter((it) => !(it.type === "person" && it.id === id)),
            )
          }
          loading={lista.isPending}
          stale={lista.isPlaceholderData}
          error={lista.isError}
          total={peopleTotal}
          pageSize={POR_PAGINA_LISTA}
          page={peoplePage}
          onPageChange={setPeoplePage}
          selectedPersonId={selectedPerson?.id ?? null}
          selectedConversationId={selectedConversation?.id ?? null}
          onSelectPerson={abrirPessoa}
          onSelectConversation={abrirConversa}
          onPersonDeleted={(id) => {
            if (selectedPerson?.id === id) setSelectedPerson(null);
          }}
          isAdmin={isAdmin}
          selectedIds={selectedIds}
          onToggleSelected={toggleSelected}
          selectedConversationIds={selectedConversationIds}
          onToggleSelectedConversation={toggleSelectedConversation}
          onMarkPersonRead={(id) => applyMarkRead([id], [])}
          onMarkConversationRead={(id) => applyMarkRead([], [id])}
          onRefresh={recarregarLista}
          mostrarCaixa={!caixaDaRota}
          rotuloCaixa={(email) =>
            rotuloCaixa(
              stats?.inboxes.find((i) => i.email === email) ?? {
                email,
                displayName: null,
              },
            )
          }
        />
      </section>

      <section
        aria-label={tx("Leitura")}
        className={cn(
          "min-h-0 min-w-0 flex-1 bg-card md:block",
          aberta ? "block" : "hidden",
        )}
      >
        {leitura ?? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="max-w-[280px] text-sm text-text-tertiary">
              {tx("Escolha uma conversa na lista.")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
