import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from "lucide-react";
import { TOAST_EVENT, type ToastInit, type ToastKind } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
interface ToastItem extends ToastInit {
  id: string;
}

const KIND_META: Record<
  ToastKind,
  { Icon: React.ElementType; ringClass: string; iconClass: string }
> = {
  info: { Icon: Info, ringClass: "ring-primary/25", iconClass: "text-primary" },
  success: {
    Icon: CheckCircle2,
    ringClass: "ring-success/30",
    iconClass: "text-success",
  },
  warning: {
    Icon: AlertTriangle,
    ringClass: "ring-warning-border",
    iconClass: "text-warning-text",
  },
  error: {
    Icon: XCircle,
    ringClass: "ring-destructive/30",
    iconClass: "text-destructive",
  },
};

/**
 * Mount once near the root (DashboardLayout). Listens for
 * `saasmail:toast` custom events and renders a small stack of
 * dismissible cards anchored to the bottom-left so they don't
 * collide with the bottom-right tray modals.
 */
export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Track timer ids so manual dismiss can clear pending auto-dismiss.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<ToastInit>).detail;
      if (!detail || typeof detail.message !== "string") return;
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      setItems((prev) => [...prev, { id, ...detail }]);
      const ms = detail.durationMs ?? 4500;
      if (ms > 0) {
        const handle = setTimeout(() => dismiss(id), ms);
        timersRef.current.set(id, handle);
      }
    }
    window.addEventListener(TOAST_EVENT, handler);
    return () => {
      window.removeEventListener(TOAST_EVENT, handler);
      // Clean up any outstanding timers if the Toaster unmounts.
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [dismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-full max-w-[360px] flex-col gap-2 sm:bottom-6 sm:left-6"
    >
      {items.map((it) => {
        const meta = KIND_META[it.kind ?? "info"];
        return (
          <div
            key={it.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-[8px] bg-card px-3.5 py-3 shadow-lg ring-1",
              meta.ringClass,
            )}
          >
            <meta.Icon
              size={16}
              className={cn("mt-0.5 shrink-0", meta.iconClass)}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">
                {it.message}
              </p>
              {it.description && (
                <p className="mt-0.5 text-xs text-text-secondary">
                  {it.description}
                </p>
              )}
              {it.action && (
                <button
                  type="button"
                  onClick={() => it.action?.onClick(() => dismiss(it.id))}
                  className="mt-1.5 inline-flex items-center text-xs font-medium text-text-primary underline-offset-2 hover:underline"
                >
                  {it.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(it.id)}
              aria-label={tx("Fechar aviso")}
              className="shrink-0 rounded-[6px] p-1 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
