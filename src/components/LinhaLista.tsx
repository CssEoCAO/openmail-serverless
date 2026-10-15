import { useRef } from "react";
import { CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
// Peças das linhas da lista (pessoa e grupo): seleção, contador e pré-carga.

/**
 * Pré-carga por intenção: o mouse parou na linha por 120 ms (ou o teclado chegou
 * nela), a conversa começa a baixar. Passar o mouse pela lista não dispara nada.
 */
export function useIntencao(acao: () => void) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  return {
    onMouseEnter: () => {
      t.current = setTimeout(acao, 120);
    },
    onMouseLeave: () => {
      if (t.current) clearTimeout(t.current);
    },
    onFocus: acao,
  };
}

export function Selecao({
  marcado,
  visivel,
  rotulo,
  onAlternar,
}: {
  marcado: boolean;
  visivel: boolean;
  rotulo: string;
  onAlternar: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={marcado}
      aria-label={rotulo}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onAlternar();
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onAlternar();
        }
      }}
      className={cn(
        "flex h-4 w-4 cursor-pointer items-center justify-center rounded-[4px] border transition-opacity",
        marcado
          ? "border-primary bg-primary text-primary-foreground"
          : "border-text-tertiary/50 bg-card",
        visivel || marcado
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100",
      )}
    >
      {marcado && (
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2.5 6.5L4.75 8.75L9.5 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

/** Contador de não lidas da linha; clicar marca tudo como lido. */
export function NaoLidasBadge({
  n,
  onMarcar,
  testId,
}: {
  n: number;
  onMarcar: () => void;
  testId?: string;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid={testId}
      title={tx("Marcar como lida")}
      aria-label={tx("{0} não lidas; marcar como lida", n)}
      onClick={(e) => {
        e.stopPropagation();
        onMarcar();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onMarcar();
        }
      }}
      className="group/badge ml-auto inline-flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary-soft px-1.5 text-[11px] font-semibold tabular-nums text-primary-ink hover:bg-primary hover:text-primary-foreground"
    >
      <span className="group-hover/badge:hidden">{n > 99 ? "99+" : n}</span>
      <CheckCheck size={12} className="hidden group-hover/badge:block" />
    </span>
  );
}
