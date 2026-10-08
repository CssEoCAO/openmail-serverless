import { useEffect, useState } from "react";
import { MarcaPublica, botaoSecundario } from "@/components/Publico";
import { useSearchParams } from "react-router-dom";

type State =
  | { kind: "loading" }
  | { kind: "suppressed"; email: string }
  | { kind: "subscribed"; email: string }
  | { kind: "error" };

/**
 * Public, unauthenticated unsubscribe landing page.
 *
 * Mounted at `/unsubscribe?token=…`. On mount, POSTs to the public
 * `/api/unsubscribe` endpoint (see worker/src/routers/unsubscribe-router.ts).
 *
 * Bot-preview-defense pattern: the initial GET serves inert HTML — the
 * actual suppression write only happens once JS mounts and fires the POST.
 * Slack/iMessage/AV link scanners don't execute JS, so they hit the inert
 * landing without recording a suppression.
 */
export default function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoToken, setUndoToken] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ kind: "error" });
      return;
    }
    let cancelled = false;
    const url = `/api/unsubscribe?token=${encodeURIComponent(token)}&source=user-link`;
    fetch(url, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) throw new Error("invalid");
        const body = (await r.json()) as {
          email: string;
          status: string;
          undoToken?: string;
        };
        if (cancelled) return;
        setState({ kind: "suppressed", email: body.email });
        setUndoToken(body.undoToken ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleResubscribe() {
    if (!undoToken) return;
    setUndoLoading(true);
    try {
      const url = `/api/unsubscribe/undo?token=${encodeURIComponent(undoToken)}`;
      const r = await fetch(url, { method: "POST" });
      if (!r.ok) {
        setUndoToken(null);
        return;
      }
      const body = (await r.json()) as { email: string; status: string };
      setState({ kind: "subscribed", email: body.email });
    } catch {
      // v1: leave the page in `suppressed` so the user can retry.
    } finally {
      setUndoLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-md flex-col gap-6">
        <MarcaPublica />
        <div className="rounded-[12px] border border-border bg-card p-7 text-center shadow-sm">
          {state.kind === "loading" && (
            <>
              <h1 className="text-lg font-semibold text-text-primary">
                Processando o pedido…
              </h1>
              <p className="mt-2 text-sm text-text-tertiary">
                Um instante enquanto atualizamos suas preferências.
              </p>
            </>
          )}

          {state.kind === "suppressed" && (
            <>
              <h1 className="text-xl font-semibold text-text-primary">
                Inscrição cancelada
              </h1>
              <p className="mt-2 break-all text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                não vai mais receber nossos e-mails.
              </p>
              <button
                type="button"
                onClick={handleResubscribe}
                disabled={undoLoading || !undoToken}
                className={`${botaoSecundario} mt-5`}
              >
                {undoLoading ? "Atualizando…" : "Voltar a receber"}
              </button>
              <p className="mt-3 text-xs text-text-tertiary">
                Mudou de ideia? Voltar a receber só reativa a entrega; não
                inscreve você em nada novo.
              </p>
            </>
          )}

          {state.kind === "subscribed" && (
            <>
              <h1 className="text-xl font-semibold text-text-primary">
                Inscrição reativada
              </h1>
              <p className="mt-2 break-all text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                volta a receber nossos e-mails.
              </p>
            </>
          )}

          {state.kind === "error" && (
            <>
              <h1 className="text-lg font-semibold text-text-primary">
                Este link de descadastro é inválido ou expirou
              </h1>
              <p className="mt-2 text-sm text-text-tertiary">
                Se continuar recebendo e-mails que não quer, responda a um deles
                e avise o remetente.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
