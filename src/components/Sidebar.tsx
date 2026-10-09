import { useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  Key,
  ListOrdered,
  LogOut,
  Mail,
  PenSquare,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  X,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { useRascunhos } from "@/lib/rascunho";
import { useOutboxCount, useStats } from "@/lib/queries";
import {
  montarArvore,
  rotuloCaixa,
  type CaixaResumo,
} from "@/lib/arvore-caixas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
const CHAVE_DOMINIOS = "saasmail.dominiosAbertos";

function lerDominiosAbertos(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_DOMINIOS) ?? "{}");
  } catch {
    return {};
  }
}

export function contagem(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Caixa aberta na rota (/inbox/<caixa>[/<pessoa>]); null em "todas" e fora da caixa. */
function caixaDaRota(pathname: string): string | null {
  const m = pathname.match(/^\/inbox\/([^/]+)/);
  if (!m || m[1] === "todas") return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const itemBase =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-primary transition-colors hover:bg-text-primary/[0.05]";
const itemAtivo = "bg-primary-soft text-primary-ink font-semibold";

function Contador({ n, forte }: { n: number; forte?: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto shrink-0 text-xs tabular-nums",
        forte ? "font-semibold text-primary-ink" : "text-text-tertiary",
      )}
    >
      {contagem(n)}
    </span>
  );
}

interface SidebarProps {
  onCompose: () => void;
  /** Chamado ao navegar: fecha a gaveta no celular. */
  onNavigate?: () => void;
  /** Mostra o X de fechar (gaveta do celular). */
  onClose?: () => void;
}

export default function Sidebar({
  onCompose,
  onNavigate,
  onClose,
}: SidebarProps) {
  const { data: session } = useSession();
  const { brandName } = useBranding();
  const { data: stats } = useStats();
  const { data: saida } = useOutboxCount();
  const rascunhos = useRascunhos();
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [filtro, setFiltro] = useState("");
  const [abertos, setAbertos] = useState(lerDominiosAbertos);
  const [comParadas, setComParadas] = useState<Set<string>>(new Set());
  const [adminAberto, setAdminAberto] = useState(() =>
    ["/inboxes", "/admin", "/blocklist"].some((p) =>
      location.pathname.startsWith(p),
    ),
  );

  const caixas: CaixaResumo[] = stats?.inboxes ?? [];
  const arvore = useMemo(
    () => montarArvore(caixas, Date.now() / 1000, filtro),
    [caixas, filtro],
  );
  const caixaAtual = caixaDaRota(location.pathname);
  const emTodas =
    location.pathname === "/" || location.pathname.startsWith("/inbox/todas");

  function alternarDominio(d: string, abertoAgora: boolean) {
    const prox = { ...abertos, [d]: !abertoAgora };
    setAbertos(prox);
    try {
      localStorage.setItem(CHAVE_DOMINIOS, JSON.stringify(prox));
    } catch {
      /* sem armazenamento: vale só nesta aba */
    }
  }

  const ir = () => onNavigate?.();

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-2.5 pb-2 pt-3">
      <div className="flex items-center gap-2 px-1.5">
        <Link
          to="/"
          onClick={ir}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-text-primary"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-primary text-primary-foreground">
            <Mail size={14} strokeWidth={2.25} aria-hidden />
          </span>
          <span className="truncate">{brandName}</span>
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={tx("Fechar menu")}
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-text-primary/[0.05] hover:text-text-primary"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          ir();
          onCompose();
        }}
        className="flex h-9 items-center justify-center gap-2 rounded-[6px] bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
      >
        <PenSquare size={15} />
        {tx("Escrever")}
      </button>

      <nav className="grid gap-px" aria-label={tx("Caixa")}>
        <Link
          to="/"
          onClick={ir}
          aria-current={emTodas ? "page" : undefined}
          className={cn(itemBase, emTodas && itemAtivo)}
        >
          <Inbox size={15} className="shrink-0" />
          <span className="truncate">{tx("Todas as caixas")}</span>
          <Contador n={stats?.unreadCount ?? 0} forte />
        </Link>
        <NavLink
          to="/rascunhos"
          onClick={ir}
          data-testid="nav-rascunhos"
          className={({ isActive }) => cn(itemBase, isActive && itemAtivo)}
        >
          <FileText size={15} className="shrink-0" />
          <span className="truncate">{tx("Rascunhos")}</span>
          <Contador n={rascunhos.porEmail.size} />
        </NavLink>
        <NavLink
          to="/outbox"
          onClick={ir}
          className={({ isActive }) => cn(itemBase, isActive && itemAtivo)}
        >
          <Clock size={15} className="shrink-0" />
          <span className="truncate">{tx("Saída")}</span>
          <Contador n={saida?.pending ?? 0} />
        </NavLink>
        <NavLink
          to="/spam"
          onClick={ir}
          data-testid="nav-spam"
          className={({ isActive }) => cn(itemBase, isActive && itemAtivo)}
        >
          <ShieldAlert size={15} className="shrink-0" />
          <span className="truncate">Spam</span>
          <Contador n={stats?.spamCount ?? 0} />
        </NavLink>
      </nav>

      <div className="mt-1 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        {tx("Caixas")}
        <span className="font-medium normal-case tracking-normal tabular-nums">
          {caixas.length || ""}
        </span>
      </div>
      <label className="relative block">
        <span className="sr-only">{tx("Filtrar caixas")}</span>
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          type="search"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder={tx("Filtrar caixas")}
          className="h-8 w-full rounded-[6px] border border-border bg-card pl-8 pr-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
        />
      </label>

      <div
        className="smooth-scroll -mx-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1"
        data-testid="inbox-tree"
      >
        {!stats ? (
          <p className="px-2 py-2 text-xs text-text-tertiary">
            {tx("Carregando…")}
          </p>
        ) : arvore.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-tertiary">
            {filtro
              ? tx("Nenhuma caixa com esse nome.")
              : tx("Nenhuma caixa ainda.")}
          </p>
        ) : (
          arvore.map((no) => {
            const padrao = no.ativas.length > 0;
            const aberto = filtro ? true : (abertos[no.dominio] ?? padrao);
            const verParadas = comParadas.has(no.dominio);
            const linhas = verParadas
              ? [...no.ativas, ...no.paradas]
              : no.ativas;
            return (
              <div
                key={no.dominio}
                data-testid="inbox-domain"
                data-domain={no.dominio}
              >
                <button
                  type="button"
                  onClick={() => alternarDominio(no.dominio, aberto)}
                  aria-expanded={aberto}
                  className="flex h-7 w-full min-w-0 items-center gap-1 rounded-[6px] px-1.5 text-left text-xs font-semibold text-text-secondary hover:bg-text-primary/[0.05]"
                >
                  {aberto ? (
                    <ChevronDown size={13} className="shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0" />
                  )}
                  <span className="truncate">{no.dominio}</span>
                  <Contador n={no.naoLidas} forte />
                </button>
                {aberto && (
                  <ul
                    className="grid grid-cols-[minmax(0,1fr)] gap-px pb-1 pl-3"
                    data-testid="inbox-list"
                  >
                    {linhas.map((c) => {
                      const ativa = caixaAtual === c.email;
                      return (
                        <li
                          key={c.email}
                          data-testid="inbox-row"
                          data-inbox={c.email}
                        >
                          <Link
                            to={`/inbox/${encodeURIComponent(c.email)}`}
                            onClick={ir}
                            title={c.email}
                            aria-current={ativa ? "page" : undefined}
                            className={cn(
                              itemBase,
                              "h-7",
                              c.naoLidas > 0 && "font-semibold",
                              ativa && itemAtivo,
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {rotuloCaixa(c)}
                            </span>
                            {!c.podeEnviar && (
                              <span
                                className="shrink-0 text-[11px] font-normal text-text-tertiary"
                                title={tx(
                                  "Recebe, mas não está configurada para enviar",
                                )}
                              >
                                {tx("só recebe")}
                              </span>
                            )}
                            <Contador n={c.naoLidas} forte />
                          </Link>
                        </li>
                      );
                    })}
                    {no.paradas.length > 0 && (
                      <li>
                        <button
                          type="button"
                          onClick={() =>
                            setComParadas((s) => {
                              const n = new Set(s);
                              if (n.has(no.dominio)) n.delete(no.dominio);
                              else n.add(no.dominio);
                              return n;
                            })
                          }
                          className="h-7 w-full rounded-[6px] px-2 text-left text-xs text-text-tertiary hover:bg-text-primary/[0.05] hover:text-text-primary"
                        >
                          {verParadas
                            ? tx("Esconder as sem movimento")
                            : tx("+{0} sem movimento", no.paradas.length)}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>

      <nav
        className="grid gap-px border-t border-border pt-2"
        aria-label={tx("Ferramentas")}
      >
        <NavLink
          to="/templates"
          onClick={ir}
          className={({ isActive }) => cn(itemBase, isActive && itemAtivo)}
        >
          <FileText size={15} className="shrink-0" />
          {tx("Modelos")}
        </NavLink>
        {isAdmin && (
          <NavLink
            to="/sequences"
            onClick={ir}
            className={({ isActive }) => cn(itemBase, isActive && itemAtivo)}
          >
            <ListOrdered size={15} className="shrink-0" />
            {tx("Sequências")}
          </NavLink>
        )}
        {isAdmin && (
          <>
            <button
              type="button"
              onClick={() => setAdminAberto((v) => !v)}
              aria-expanded={adminAberto}
              className={itemBase}
            >
              <Shield size={15} className="shrink-0" />
              {tx("Administração")}
              {adminAberto ? (
                <ChevronDown size={14} className="ml-auto text-text-tertiary" />
              ) : (
                <ChevronRight
                  size={14}
                  className="ml-auto text-text-tertiary"
                />
              )}
            </button>
            {adminAberto && (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-px pl-6">
                {[
                  ["/inboxes", tx("Caixas e envio")],
                  ["/admin/users", tx("Usuários")],
                  ["/blocklist", tx("Bloqueios")],
                  ["/admin/suppressions", tx("Supressões")],
                ].map(([to, rotulo]) => (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={ir}
                    className={({ isActive }) =>
                      cn(itemBase, "h-7", isActive && itemAtivo)
                    }
                  >
                    {rotulo}
                  </NavLink>
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-10 w-full min-w-0 items-center gap-2 rounded-[6px] px-1.5 text-left hover:bg-text-primary/[0.05]"
            title={session?.user?.email}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-ink">
              {iniciais(session?.user?.name || session?.user?.email || "?")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text-primary">
                {session?.user?.name || session?.user?.email}
              </span>
              {isAdmin && (
                <span className="block text-[11px] text-text-tertiary">
                  {tx("Administrador")}
                </span>
              )}
            </span>
            <Settings size={15} className="shrink-0 text-text-tertiary" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-text-primary">
              {session?.user?.name || tx("Conta")}
            </p>
            <p className="truncate text-xs text-text-tertiary">
              {session?.user?.email}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              ir();
              navigate("/settings");
            }}
          >
            <Settings />
            {tx("Configurações")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              ir();
              navigate("/api-keys");
            }}
          >
            <Key />
            {tx("Chave de API")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="logout-button"
            onClick={() => signOut()}
            className="text-destructive focus:text-destructive"
          >
            <LogOut />
            {tx("Sair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function iniciais(nome: string): string {
  const partes = nome
    .split("@")[0]
    .split(/[\s.\-_]+/)
    .filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}
