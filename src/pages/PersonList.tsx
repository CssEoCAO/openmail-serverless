import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deletePerson,
  type GroupedItem,
  type GroupedPerson,
  type GroupedConversation,
} from "@/lib/api";
import { preCarregarConversa, preCarregarPessoa } from "@/lib/queries";
import { quandoCurto, plural } from "@/lib/datas";
import GroupRow from "@/components/GroupRow";
import { NaoLidasBadge, Selecao, useIntencao } from "@/components/LinhaLista";
import RascunhoPill from "@/components/RascunhoPill";
import { useRascunhos } from "@/lib/rascunho";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { tx } from "@/lib/i18n";
interface PersonListProps {
  /** Linhas de pessoa e de grupo vindas de /api/people/grouped. */
  items: GroupedItem[];
  /** Tira a pessoa da lista em cache depois de excluir. */
  onDelete: (personId: string) => void;
  loading: boolean;
  /** Mostrando a lista anterior enquanto a nova carrega. */
  stale?: boolean;
  error?: boolean;
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
  selectedPersonId: string | null;
  selectedConversationId: string | null;
  onSelectPerson: (person: GroupedPerson) => void;
  onSelectConversation: (conv: GroupedConversation) => void;
  onPersonDeleted?: (personId: string) => void;
  isAdmin?: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  selectedConversationIds: Set<string>;
  onToggleSelectedConversation: (id: string) => void;
  onMarkPersonRead: (id: string) => void;
  onMarkConversationRead: (id: string) => void;
  /** Puxar para atualizar (celular) e "tentar de novo". */
  onRefresh: () => Promise<unknown> | void;
  /** Em "Todas as caixas" cada linha diz de qual caixa é. */
  mostrarCaixa: boolean;
  rotuloCaixa: (email: string) => string;
}

function LinhaPessoa({
  person,
  selecionada,
  marcada,
  algumaMarcada,
  mostrarCaixa,
  rotuloCaixa,
  temRascunho,
  isAdmin,
  onSelect,
  onToggle,
  onMarkRead,
  onDelete,
}: {
  person: GroupedPerson;
  selecionada: boolean;
  marcada: boolean;
  algumaMarcada: boolean;
  mostrarCaixa: boolean;
  rotuloCaixa: (email: string) => string;
  temRascunho: boolean;
  isAdmin: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMarkRead: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const intencao = useIntencao(() => preCarregarPessoa(qc, person.id));
  const naoLida = person.unreadCount > 0;
  const assunto = person.latestSubject?.trim() || tx("(sem assunto)");
  const caixas = person.recipients ?? [];

  return (
    <li
      className={cn(
        "group relative border-b border-border-subtle",
        selecionada
          ? "bg-primary-soft"
          : marcada
            ? "bg-primary-soft/60"
            : "hover:bg-bg-subtle",
      )}
    >
      {selecionada && (
        <span
          className="absolute inset-y-0 left-0 w-[3px] bg-primary"
          aria-hidden
        />
      )}
      <button
        type="button"
        data-testid="person-row"
        data-person-id={person.id}
        onClick={onSelect}
        {...intencao}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 py-2.5 pl-2.5 pr-3 text-left focus:outline-none focus-visible:bg-bg-subtle"
      >
        <span className="flex h-4 items-center justify-center self-center">
          {marcada || algumaMarcada ? (
            <Selecao
              marcado={marcada}
              visivel
              rotulo={`Selecionar ${person.name || person.email}`}
              onAlternar={onToggle}
            />
          ) : (
            <>
              <span
                className={cn(
                  "h-2 w-2 rounded-full bg-primary group-hover:hidden",
                  !naoLida && "invisible",
                )}
                aria-hidden
              />
              <span className="hidden group-hover:flex">
                <Selecao
                  marcado={false}
                  visivel
                  rotulo={`Selecionar ${person.name || person.email}`}
                  onAlternar={onToggle}
                />
              </span>
            </>
          )}
        </span>
        <span
          className={cn(
            "truncate text-[13px] text-text-primary",
            naoLida ? "font-semibold" : "font-medium",
          )}
          title={person.email}
        >
          {person.name || person.email}
        </span>
        <span
          className={cn(
            "text-xs tabular-nums",
            naoLida ? "font-semibold text-primary-ink" : "text-text-tertiary",
          )}
        >
          {quandoCurto(person.lastEmailAt)}
        </span>

        <span
          className={cn(
            "col-start-2 col-end-4 truncate text-[13px]",
            naoLida ? "text-text-primary" : "text-text-secondary",
          )}
          title={assunto}
        >
          {assunto}
        </span>

        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary">
          {mostrarCaixa && caixas.length > 0 && (
            <span
              className="max-w-[150px] truncate rounded-[4px] border border-border px-1.5 text-[11px] leading-[18px]"
              title={caixas.join(", ")}
            >
              {rotuloCaixa(caixas[0])}
              {caixas.length > 1 ? ` +${caixas.length - 1}` : ""}
            </span>
          )}
          <span className="tabular-nums">
            {plural(person.totalCount, "mensagem", "mensagens")}
          </span>
          {person.hasAttachment === 1 && (
            <Paperclip size={12} aria-label={tx("Tem anexo")} />
          )}
          {temRascunho && <RascunhoPill />}
          {naoLida && (
            <NaoLidasBadge
              n={person.unreadCount}
              onMarcar={onMarkRead}
              testId="person-unread-badge"
            />
          )}
        </span>
      </button>

      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="person-kebab-menu"
              data-person-id={person.id}
              aria-label={tx("Ações da pessoa")}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-[4px] bg-card text-text-tertiary opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              data-testid="person-delete-button"
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {tx("Excluir pessoa")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

export default function PersonList({
  items,
  onDelete,
  loading,
  stale,
  error,
  total,
  pageSize,
  page,
  onPageChange,
  selectedPersonId,
  selectedConversationId,
  onSelectPerson,
  onSelectConversation,
  onPersonDeleted,
  isAdmin = false,
  selectedIds,
  onToggleSelected,
  selectedConversationIds,
  onToggleSelectedConversation,
  onMarkPersonRead,
  onMarkConversationRead,
  onRefresh,
  mostrarCaixa,
  rotuloCaixa,
}: PersonListProps) {
  const qc = useQueryClient();
  const rascunhos = useRascunhos();
  const [erroExcluir, setErroExcluir] = useState("");
  const {
    ref: scrollRef,
    pullDistance,
    refreshing,
    threshold,
  } = usePullToRefresh<HTMLDivElement>({ onRefresh });
  const puxando = pullDistance > 0 || refreshing;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const algumaMarcada =
    selectedIds.size > 0 || selectedConversationIds.size > 0;

  async function excluir(person: GroupedPerson) {
    if (
      !confirm(
        tx(
          "Excluir {0} e as {1} para sempre? Não dá para desfazer.",
          person.name || person.email,
          plural(person.totalCount, "mensagem", "mensagens"),
        ),
      )
    )
      return;
    try {
      await deletePerson(person.id);
      setErroExcluir("");
      onDelete(person.id);
      onPersonDeleted?.(person.id);
    } catch {
      setErroExcluir(tx("Não deu para excluir. Tente de novo."));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {erroExcluir && (
        <p
          role="alert"
          className="border-b border-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
        >
          {erroExcluir}
        </p>
      )}
      <div
        ref={scrollRef}
        className="smooth-scroll relative min-h-0 flex-1 overflow-y-auto"
        style={{ overscrollBehaviorY: "contain" }}
      >
        {puxando && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center"
            style={{
              height: pullDistance,
              opacity: Math.min(1, pullDistance / threshold),
            }}
          >
            <RefreshCw
              size={18}
              className={cn("text-text-tertiary", refreshing && "animate-spin")}
              style={
                refreshing
                  ? undefined
                  : {
                      transform: `rotate(${(pullDistance / threshold) * 270}deg)`,
                    }
              }
            />
          </div>
        )}
        <div
          style={{
            transform: puxando ? `translateY(${pullDistance}px)` : undefined,
            transition:
              pullDistance === 0 ? "transform 0.2s ease-out" : undefined,
          }}
          className={cn(stale && "opacity-60 transition-opacity")}
        >
          {loading ? (
            <ul aria-busy="true" aria-label={tx("Carregando conversas")}>
              {Array.from({ length: 8 }, (_, i) => (
                <li
                  key={i}
                  className="grid gap-1.5 border-b border-border-subtle px-3 py-3 pl-[34px]"
                >
                  <span className="h-3 w-2/5 rounded bg-bg-muted" />
                  <span className="h-3 w-4/5 rounded bg-bg-muted" />
                </li>
              ))}
            </ul>
          ) : error && items.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-text-primary">
                {tx("Não deu para carregar as conversas.")}
              </p>
              <button
                type="button"
                onClick={() => void onRefresh()}
                className="mt-2 text-sm font-medium text-primary-ink hover:underline"
              >
                {tx("Tentar de novo")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-text-primary">
                {tx("Nenhuma conversa aqui")}
              </p>
              <p className="mt-1 text-xs text-text-tertiary">
                {tx("Tente outra busca ou tire os filtros.")}
              </p>
            </div>
          ) : (
            <ul>
              {items.map((item) =>
                item.type === "group" ? (
                  <GroupRow
                    key={`g_${item.id}`}
                    group={item}
                    isSelected={selectedConversationId === item.id}
                    marcada={selectedConversationIds.has(item.id)}
                    algumaMarcada={algumaMarcada}
                    mostrarCaixa={mostrarCaixa}
                    rotuloCaixa={rotuloCaixa}
                    onSelect={() => onSelectConversation(item)}
                    onToggle={() => onToggleSelectedConversation(item.id)}
                    onMarkRead={() => onMarkConversationRead(item.id)}
                    onIntencao={() => preCarregarConversa(qc, item.id)}
                  />
                ) : (
                  <LinhaPessoa
                    key={item.id}
                    person={item}
                    selecionada={selectedPersonId === item.id}
                    marcada={selectedIds.has(item.id)}
                    algumaMarcada={algumaMarcada}
                    mostrarCaixa={mostrarCaixa}
                    rotuloCaixa={rotuloCaixa}
                    temRascunho={rascunhos.porPessoa.has(item.id)}
                    isAdmin={isAdmin}
                    onSelect={() => onSelectPerson(item)}
                    onToggle={() => onToggleSelected(item.id)}
                    onMarkRead={() => onMarkPersonRead(item.id)}
                    onDelete={() => void excluir(item)}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5 text-xs text-text-tertiary">
          <span className="tabular-nums">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}{" "}
            {tx("de")} {total}
          </span>
          {totalPages > 1 && (
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
                aria-label={tx("Página anterior")}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] hover:bg-text-primary/[0.05] hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                aria-label={tx("Próxima página")}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] hover:bg-text-primary/[0.05] hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight size={15} />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
