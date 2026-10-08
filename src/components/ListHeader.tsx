import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  LayoutList,
  Paperclip,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import {
  defaultDirectionFor,
  type InboxSort,
  type InboxSortSpec,
} from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface InboxFilters {
  recipient?: string;
  unread?: boolean;
  hasAttachment?: boolean;
}

export type InboxView = "list" | "table";

const ORDENS: Array<{ value: InboxSort; label: string }> = [
  { value: "recency", label: "Mais recentes" },
  { value: "unread", label: "Não lidas primeiro" },
  { value: "inbox", label: "Por caixa" },
  { value: "attachments", label: "Com anexo primeiro" },
];

interface ListHeaderProps {
  titulo: string;
  /** Endereço da caixa aberta, embaixo do título. */
  endereco?: string;
  naoLidas: number;
  conversas: number | null;
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  search: string;
  onSearchChange: (q: string) => void;
  view: InboxView;
  onViewChange: (v: InboxView) => void;
  sortSpec: InboxSortSpec;
  onSortChange: (spec: InboxSortSpec) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function Chip({
  ativo,
  onClick,
  children,
}: {
  ativo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
        ativo
          ? "border-text-primary bg-text-primary text-card"
          : "border-border bg-card text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

/** Topo da lista: título da caixa, busca, filtros e ordem. */
export default function ListHeader({
  titulo,
  endereco,
  naoLidas,
  conversas,
  filters,
  onFiltersChange,
  search,
  onSearchChange,
  view,
  onViewChange,
  sortSpec,
  onSortChange,
  onRefresh,
  refreshing,
}: ListHeaderProps) {
  const rotuloOrdem =
    ORDENS.find((o) => o.value === sortSpec.key)?.label ?? "Mais recentes";
  const filtrando = !!filters.unread || !!filters.hasAttachment;

  return (
    <div className="grid shrink-0 gap-2 border-b border-border px-3 pb-2.5 pt-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-[15px] font-semibold text-text-primary"
            title={endereco}
          >
            {titulo}
          </h1>
          <p className="truncate text-xs text-text-tertiary tabular-nums">
            {endereco ? `${endereco} · ` : ""}
            {conversas === null
              ? "Carregando…"
              : `${naoLidas} não ${naoLidas === 1 ? "lida" : "lidas"} · ${conversas} ${conversas === 1 ? "conversa" : "conversas"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Atualizar"
          title="Atualizar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-text-primary/[0.05] hover:text-text-primary disabled:opacity-60"
        >
          <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => onViewChange(view === "list" ? "table" : "list")}
          aria-label={view === "list" ? "Ver como tabela" : "Ver como lista"}
          title={view === "list" ? "Ver como tabela" : "Ver como lista"}
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-text-primary/[0.05] hover:text-text-primary md:flex"
        >
          {view === "list" ? <Table2 size={15} /> : <LayoutList size={15} />}
        </button>
      </div>

      <label className="relative block">
        <span className="sr-only">Buscar</span>
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          data-testid="person-search-input"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar por nome, e-mail ou assunto"
          className="h-8 w-full rounded-[6px] border border-border bg-bg-subtle pl-8 pr-8 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:bg-card focus:outline-none"
        />
        {search && (
          <button
            type="button"
            data-testid="person-search-clear"
            onClick={() => onSearchChange("")}
            aria-label="Limpar busca"
            className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[4px] text-text-tertiary hover:text-text-primary"
          >
            <X size={13} />
          </button>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          ativo={!!filters.unread}
          onClick={() =>
            onFiltersChange({ ...filters, unread: !filters.unread })
          }
        >
          Não lidas
        </Chip>
        <Chip
          ativo={!!filters.hasAttachment}
          onClick={() =>
            onFiltersChange({
              ...filters,
              hasAttachment: !filters.hasAttachment,
            })
          }
        >
          <Paperclip size={12} />
          Com anexo
        </Chip>
        {filtrando && (
          <button
            type="button"
            onClick={() =>
              onFiltersChange({
                ...filters,
                unread: false,
                hasAttachment: false,
              })
            }
            className="h-7 rounded-[6px] px-1.5 text-xs text-text-tertiary hover:text-text-primary"
          >
            Limpar
          </button>
        )}

        <span className="ml-auto inline-flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-secondary hover:bg-text-primary/[0.05] hover:text-text-primary"
              >
                {rotuloOrdem}
                <ChevronDown size={13} className="opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {ORDENS.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onClick={() =>
                    onSortChange({
                      key: o.value,
                      direction:
                        o.value === sortSpec.key
                          ? sortSpec.direction
                          : defaultDirectionFor(o.value),
                    })
                  }
                >
                  <span className="flex-1">{o.label}</span>
                  {o.value === sortSpec.key && <Check />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() =>
              onSortChange({
                key: sortSpec.key,
                direction: sortSpec.direction === "asc" ? "desc" : "asc",
              })
            }
            aria-label={
              sortSpec.direction === "asc"
                ? "Ordem crescente; inverter"
                : "Ordem decrescente; inverter"
            }
            title="Inverter a ordem"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-text-primary/[0.05] hover:text-text-primary"
          >
            {sortSpec.direction === "asc" ? (
              <ArrowUp size={13} />
            ) : (
              <ArrowDown size={13} />
            )}
          </button>
        </span>
      </div>
    </div>
  );
}
