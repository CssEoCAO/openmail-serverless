import { CheckCheck, X, Loader2, ShieldBan } from "lucide-react";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
interface SelectionBarProps {
  count: number;
  busy?: boolean;
  onMarkRead: () => void;
  onBlock?: () => void;
  onClear: () => void;
  className?: string;
}

/**
 * Floating bar that appears above the inbox card when one or more people
 * are selected. Hosts bulk actions (mark read, clear). Sticky-positioned
 * via the parent so it doesn't shift content.
 */
export default function SelectionBar({
  count,
  busy,
  onMarkRead,
  onBlock,
  onClear,
  className,
}: SelectionBarProps) {
  if (count === 0) return null;
  return (
    <div
      data-testid="selection-bar"
      className={cn(
        "flex items-center gap-2 rounded-[6px] border border-primary/30 bg-primary-soft px-2.5 py-1.5 text-sm text-primary-ink",
        className,
      )}
    >
      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2 text-xs font-semibold tabular-nums text-primary-foreground">
        {count}
      </span>
      <span className="font-medium">
        {count === 1 ? "marcada" : "marcadas"}
      </span>

      <span className="mx-0.5 h-4 w-px bg-primary/20" aria-hidden />

      <button
        type="button"
        onClick={onMarkRead}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <CheckCheck size={12} />
        )}
        {tx("Marcar como lida")}
      </button>

      {onBlock && (
        <button
          type="button"
          onClick={onBlock}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShieldBan size={12} />
          {tx("Bloquear")}
        </button>
      )}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors hover:bg-primary/10"
        aria-label={tx("Desmarcar tudo")}
      >
        <X size={12} />
        {tx("Desmarcar")}
      </button>
    </div>
  );
}
