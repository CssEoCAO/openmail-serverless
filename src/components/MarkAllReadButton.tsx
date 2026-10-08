import { CheckCheck } from "lucide-react";

interface MarkAllReadButtonProps {
  /** Não lidas no escopo; com 0 o botão não aparece. */
  unreadCount: number;
  /** O que "tudo" cobre, para o title: a caixa da aba aberta ou a do grupo. */
  scopeLabel: string;
  onMarkAllRead: () => void;
}

/**
 * O único "marcar como lida" da conversa. Aba de pessoa e conversa em grupo põem
 * no mesmo lugar do cabeçalho, para o botão não mudar de posição.
 */
export default function MarkAllReadButton({
  unreadCount,
  scopeLabel,
  onMarkAllRead,
}: MarkAllReadButtonProps) {
  if (unreadCount <= 0) return null;

  return (
    <button
      type="button"
      data-testid="mark-all-read"
      onClick={onMarkAllRead}
      title={`Marcar as ${unreadCount} não lidas de ${scopeLabel} como lidas`}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-subtle hover:text-text-primary"
    >
      <CheckCheck size={14} />
      Marcar como lida
      <span className="rounded-full bg-primary-soft px-1.5 text-[11px] font-semibold tabular-nums text-primary-ink">
        {unreadCount}
      </span>
    </button>
  );
}
