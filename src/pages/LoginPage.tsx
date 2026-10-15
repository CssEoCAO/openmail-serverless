import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ArrowRight, Fingerprint, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import {
  CartaoPublico,
  ErroPublico,
  botaoPrimario,
  botaoSecundario,
  campoPublico,
  rotuloPublico,
} from "@/components/Publico";

import { tx } from "@/lib/i18n";
export default function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (!cancelled) setSetupRequired(data.setupRequired);
      } catch {
        if (!cancelled) setSetupRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (setupRequired === null) {
    return <p className="text-sm text-text-tertiary">{tx("Carregando…")}</p>;
  }

  if (setupRequired) {
    return <Navigate to="/onboarding" replace />;
  }

  async function handlePasskeyLogin() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(
          result.error.message || tx("Não deu para entrar com a passkey."),
        );
      } else {
        window.location.href = "/";
      }
    } catch {
      setError(tx("Não deu para entrar com a passkey. Tente de novo."));
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result?.error) {
        setError(
          result.error.message ||
            tx("E-mail ou senha não conferem. Tente de novo."),
        );
      } else {
        window.location.href = "/";
      }
    } catch {
      setError(tx("Não deu para entrar. Tente de novo."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <CartaoPublico
      titulo={tx("Entrar")}
      subtitulo={
        mode === "passkey"
          ? "Use a passkey deste aparelho."
          : tx("Conta sem passkey: entre com e-mail e senha.")
      }
    >
      {error && <ErroPublico>{error}</ErroPublico>}

      {mode === "passkey" ? (
        <div className="grid gap-2.5">
          <button
            type="button"
            onClick={handlePasskeyLogin}
            disabled={loading}
            className={botaoPrimario}
          >
            <Fingerprint size={16} />
            {loading ? tx("Entrando…") : tx("Entrar com passkey")}
          </button>
          <button
            type="button"
            onClick={() => {
              setError("");
              setMode("password");
            }}
            className={botaoSecundario}
          >
            <Mail size={16} />
            {tx("Entrar com e-mail e senha")}
          </button>
        </div>
      ) : (
        <form onSubmit={handlePasswordLogin} className="grid gap-3.5">
          <label className="grid gap-1.5">
            <span className={rotuloPublico}>{tx("E-mail")}</span>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={campoPublico}
            />
          </label>
          <label className="grid gap-1.5">
            <span className={rotuloPublico}>{tx("Senha")}</span>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={campoPublico}
            />
          </label>
          <button type="submit" disabled={loading} className={botaoPrimario}>
            {loading ? (
              tx("Entrando…")
            ) : (
              <>
                {tx("Entrar")}
                <ArrowRight size={16} aria-hidden />
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setError("");
              setMode("passkey");
            }}
            className="text-center text-xs text-text-tertiary hover:text-text-primary"
          >
            {tx("Entrar com passkey")}
          </button>
        </form>
      )}
    </CartaoPublico>
  );
}
