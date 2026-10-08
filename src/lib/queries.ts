import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  defaultDirectionFor,
  fetchConversationEmails,
  fetchGroupedPeople,
  fetchOutboxCount,
  fetchPersonEmails,
  fetchStats,
  type InboxSort,
  type InboxSortSpec,
} from "@/lib/api";

/**
 * Dados de servidor compartilhados pelas telas da caixa. Antes cada componente
 * pedia o seu: a contagem de caixas saía 3 vezes na abertura e de novo a cada
 * clique. Aqui é uma chamada por chave, guardada em cache e invalidada quando
 * chega e-mail (WebSocket) ou quando uma ação muda o que está na tela.
 */
export const chaves = {
  stats: ["stats"] as const,
  saida: ["outbox-count"] as const,
  conversas: ["conversas"] as const,
  emailsPessoa: (id: string) => ["emails-pessoa", id] as const,
  conversa: (id: string) => ["conversa", id] as const,
};

/** A API devolve no máximo 10 mensagens por página. */
const POR_PAGINA = 10;

/** Linhas por página da lista da caixa. */
export const POR_PAGINA_LISTA = 40;

const opcoesStats = queryOptions({
  queryKey: chaves.stats,
  queryFn: () => fetchStats(),
});

export function useStats() {
  return useQuery(opcoesStats);
}

export type ConsultaLista = NonNullable<
  Parameters<typeof fetchGroupedPeople>[0]
>;

/** Lista da caixa (pessoas e conversas em grupo) para um filtro e uma ordem. */
export function opcoesLista(q: ConsultaLista) {
  return queryOptions({
    queryKey: [...chaves.conversas, q] as const,
    queryFn: () => fetchGroupedPeople(q),
    staleTime: 15_000,
  });
}

const ORDENS_VALIDAS = new Set<InboxSort>([
  "recency",
  "unread",
  "inbox",
  "attachments",
]);

/** Ordem da lista escolhida da última vez (localStorage). */
export function lerOrdem(): InboxSortSpec {
  // Salvo como JSON ({key, direction}); aceita também a forma antiga, só a chave.
  try {
    const salvo = window.localStorage?.getItem("saasmail.inboxSort");
    if (!salvo) return { key: "recency", direction: "desc" };
    if (ORDENS_VALIDAS.has(salvo as InboxSort)) {
      return {
        key: salvo as InboxSort,
        direction: defaultDirectionFor(salvo as InboxSort),
      };
    }
    const p = JSON.parse(salvo);
    if (
      ORDENS_VALIDAS.has(p?.key) &&
      (p.direction === "asc" || p.direction === "desc")
    )
      return p as InboxSortSpec;
  } catch {
    /* valor antigo ou armazenamento bloqueado: ordem padrão */
  }
  return { key: "recency", direction: "desc" };
}

/**
 * Abertura do app: a caixa pede contagens e lista assim que monta, mas só monta
 * depois da checagem de sessão. Pedir junto com a sessão poupa uma ida e volta
 * inteira (~0,8 s na latência de hoje). Sem sessão viram 401, e 401 não se
 * repete (o retry padrão pediria tudo de novo 1 s depois, já na tela de login).
 * A chave tem que ser a mesma que a InboxPage monta, senão baixa duas vezes.
 */
export function preCarregarAbertura(qc: QueryClient, caminho: string) {
  void qc.prefetchQuery({ ...opcoesStats, retry: false });
  const m = caminho.match(/^\/(?:inbox\/([^/]+)(?:\/[^/]+)?)?\/?$/);
  if (!m) return;
  let caixa: string | undefined;
  try {
    caixa = m[1] && m[1] !== "todas" ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return;
  }
  const { key, direction } = lerOrdem();
  void qc.prefetchQuery({
    ...opcoesLista({
      recipient: caixa,
      sort: key,
      direction,
      page: 1,
      limit: POR_PAGINA_LISTA,
    }),
    retry: false,
  });
}

export function useOutboxCount() {
  return useQuery({
    queryKey: chaves.saida,
    queryFn: fetchOutboxCount,
    staleTime: 60_000,
  });
}

function opcoesEmailsPessoa(id: string) {
  return infiniteQueryOptions({
    queryKey: chaves.emailsPessoa(id),
    queryFn: ({ pageParam }) => fetchPersonEmails(id, { page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (ultima, todas) =>
      ultima.emails.length < POR_PAGINA ? undefined : todas.length + 1,
  });
}

/** Mensagens de uma pessoa, da mais nova para a mais antiga; "mais antigas" anexa a próxima página. */
export function useEmailsPessoa(id: string) {
  return useInfiniteQuery(opcoesEmailsPessoa(id));
}

function opcoesConversa(id: string) {
  return infiniteQueryOptions({
    queryKey: chaves.conversa(id),
    queryFn: ({ pageParam }) => fetchConversationEmails(id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (ultima, todas) =>
      ultima.emails.length < POR_PAGINA ? undefined : todas.length + 1,
  });
}

/** Linha do tempo de uma conversa em grupo (página 1 = as 10 mais novas). */
export function useConversa(id: string) {
  return useInfiniteQuery(opcoesConversa(id));
}

/**
 * Começa a baixar a conversa quando o mouse passa pela linha: quando o clique
 * chega, a leitura abre do cache. Não refaz se o que está no cache ainda vale.
 */
export function preCarregarPessoa(qc: QueryClient, id: string) {
  void qc.prefetchInfiniteQuery(opcoesEmailsPessoa(id));
}

export function preCarregarConversa(qc: QueryClient, id: string) {
  void qc.prefetchInfiniteQuery(opcoesConversa(id));
}

/** Aplica `fn` a todas as páginas já baixadas de uma consulta paginada. */
export function mapearPaginas<T>(
  dados: InfiniteData<T> | undefined,
  fn: (pagina: T) => T,
): InfiniteData<T> | undefined {
  return dados ? { ...dados, pages: dados.pages.map(fn) } : dados;
}
