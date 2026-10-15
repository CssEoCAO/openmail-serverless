import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import {
  CartaoPublico,
  ErroPublico,
  botaoPrimario,
  botaoSecundario,
} from "@/components/Publico";

import { tx } from "@/lib/i18n";
/**
 * Copy shown for each scope on the authorization screen. Anything not listed
 * falls back to the raw scope string rather than being hidden — a user must
 * never approve a permission we failed to describe.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: tx("Confirmar quem você é"),
  profile: tx("Ler seu nome e perfil"),
  email: tx("Ler seu endereço de e-mail"),
  offline_access: tx(
    "Continuar conectado quando você não estiver usando o app",
  ),
  "email:read": tx("Ler seus e-mails, contatos e modelos"),
  "email:send": tx("Enviar e-mails e inscrever contatos em sequências"),
  "email:manage": tx("Marcar e-mails como lidos e excluir e-mails"),
};

/**
 * Scopes that let a client act, not just look. An assistant connected to a
 * mailbox reads attacker-authored content by definition, so granting these
 * alongside read access is what turns a prompt injection into an outbound
 * message or a deletion. They are called out rather than listed flatly.
 */
const ELEVATED_SCOPES = new Set(["email:send", "email:manage"]);

export default function ConsentPage() {
  const { brandName } = useBranding();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"allowed" | "denied" | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [clientUri, setClientUri] = useState<string | null>(null);

  const clientId = searchParams.get("client_id");
  const scopes = (searchParams.get("scope") ?? "").split(" ").filter(Boolean);
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const normalizedOrigin = (value: string) => {
    try {
      const url = new URL(value);
      return url.origin === "null"
        ? `${url.protocol}//${url.host}${url.pathname}`
        : url.origin;
    } catch {
      return tx("Destino inválido ou ausente");
    }
  };

  // Show the registered application name rather than an opaque client id —
  // a user cannot make a meaningful trust decision about a random string.
  // Clients self-register, so treat the name as untrusted display text.
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await authClient.$fetch(
          `/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
          { method: "GET" },
        )) as {
          data?: { name?: string; client_name?: string; client_uri?: string };
        };
        const name = res.data?.name ?? res.data?.client_name;
        if (!cancelled && name) setClientName(name);
        if (!cancelled) setClientUri(res.data?.client_uri ?? null);
      } catch {
        // Fall back to the client id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function handleConsent(accept: boolean) {
    setLoading(accept ? "allow" : "deny");
    setError(null);
    try {
      // oauthProviderClient injects `oauth_query` from window.location.search;
      // the endpoint verifies its signature and rebuilds the pending request.
      const res = (await authClient.$fetch("/oauth2/consent", {
        method: "POST",
        body: { accept },
      })) as { data?: { redirect?: boolean; url?: string } };

      if (res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
      setResult(accept ? "allowed" : "denied");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tx("Não deu para registrar a resposta."),
      );
      setLoading(null);
    }
  }

  if (!clientId) {
    return (
      <CartaoPublico
        titulo={tx("Pedido inválido")}
        subtitulo={tx(
          "Este pedido de autorização está incompleto ou expirou. Comece de novo pelo aplicativo que você estava conectando.",
        )}
      >
        {null}
      </CartaoPublico>
    );
  }

  if (result) {
    return (
      <CartaoPublico
        titulo={
          result === "allowed" ? tx("Acesso liberado") : tx("Acesso negado")
        }
        subtitulo={tx("Pode fechar esta janela e voltar ao aplicativo.")}
      >
        {null}
      </CartaoPublico>
    );
  }

  return (
    <CartaoPublico titulo={tx("Autorizar acesso")}>
      <div className="mb-4 flex items-start gap-3">
        <ShieldCheck
          className="mt-0.5 h-5 w-5 shrink-0 text-primary"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm text-text-primary">
            <span className="font-semibold">{clientName ?? clientId}</span>{" "}
            {tx("quer acessar sua conta em")} {brandName}.
          </p>
          {clientName && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">
              {clientId}
            </p>
          )}
        </div>
      </div>

      <div className="mb-4 grid gap-1 rounded-[6px] border border-warning-border bg-warning-bg p-3 text-xs text-warning-text">
        <p className="font-semibold">{tx("Aplicativo não verificado")}</p>
        <p>
          {tx(
            "Nome e site são informados pelo próprio aplicativo; não confirmam quem o publicou.",
          )}
        </p>
        <p className="mt-1 break-all">
          {tx("Destino da autorização:")} {normalizedOrigin(redirectUri)}
        </p>
        <p className="break-all">
          {tx("Site do aplicativo:")}{" "}
          {clientUri ? normalizedOrigin(clientUri) : tx("não informado")}
        </p>
        {clientUri &&
          normalizedOrigin(clientUri) !== normalizedOrigin(redirectUri) && (
            <p className="mt-1">
              {tx(
                "O site e o destino são diferentes. Confira os dois antes de continuar.",
              )}
            </p>
          )}
      </div>

      {error && <ErroPublico>{error}</ErroPublico>}

      <p className="mb-2 text-xs font-medium text-text-secondary">
        {tx("Ele vai poder")}
      </p>
      <ul className="mb-4 grid gap-1.5">
        {scopes.map((s) => {
          const elevated = ELEVATED_SCOPES.has(s);
          return (
            <li
              key={s}
              className={
                elevated
                  ? "flex items-start gap-2 rounded-[6px] border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
                  : "flex items-start gap-2 rounded-[6px] border border-border bg-bg-subtle px-3 py-2 text-xs text-text-primary"
              }
            >
              {elevated ? (
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  strokeWidth={2.5}
                  aria-hidden
                />
              ) : (
                <Check
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
                  strokeWidth={2.5}
                  aria-hidden
                />
              )}
              <span>{SCOPE_DESCRIPTIONS[s] ?? s}</span>
            </li>
          );
        })}
      </ul>

      {scopes.some((s) => ELEVATED_SCOPES.has(s)) && (
        <p className="mb-5 rounded-[6px] border border-warning-border bg-warning-bg px-3 py-2 text-xs leading-relaxed text-warning-text">
          {tx(
            "Este aplicativo pode agir na sua caixa, não só ler. Tudo o que ele lê, inclusive e-mail de desconhecidos, pode influenciar o que ele faz depois. Só continue se confia nele para enviar e excluir.",
          )}
        </p>
      )}

      <div className="grid gap-2.5">
        <button
          type="button"
          onClick={() => handleConsent(true)}
          disabled={loading !== null}
          className={botaoPrimario}
        >
          {loading === "allow" ? tx("Autorizando…") : tx("Autorizar")}
        </button>
        <button
          type="button"
          onClick={() => handleConsent(false)}
          disabled={loading !== null}
          className={botaoSecundario}
        >
          {loading === "deny" ? tx("Negando…") : tx("Negar")}
        </button>
      </div>

      <p className="mt-5 text-center text-xs text-text-tertiary">
        {tx(
          "Só autorize aplicativos em que você confia. Dá para revogar depois.",
        )}
      </p>
    </CartaoPublico>
  );
}
