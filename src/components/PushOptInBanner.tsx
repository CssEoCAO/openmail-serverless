import { useState } from "react";
import { enablePush, markPromptDismissed, motivoPush } from "@/lib/push";

export function PushOptInBanner({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    const result = await enablePush();
    setBusy(false);
    if (result.ok) {
      markPromptDismissed();
      onClose();
    } else {
      setError(motivoPush("reason" in result ? result.reason : ""));
    }
  }

  function handleDismiss() {
    markPromptDismissed();
    onClose();
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-primary-soft px-4 py-2.5 text-sm">
      <div>
        <p className="font-medium text-text-primary">
          Receber aviso de e-mail novo mesmo com a aba fechada
        </p>
        {error ? (
          <p className="mt-1 text-xs text-destructive">
            Não deu para ligar as notificações: {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-text-secondary">
            O navegador avisa quando chega e-mail, como um app.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          className="rounded-[6px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onClick={handleEnable}
        >
          {busy ? "…" : "Ligar"}
        </button>
        <button
          className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-primary"
          onClick={handleDismiss}
        >
          Agora não
        </button>
      </div>
    </div>
  );
}
