import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { validateInvite, acceptInvite } from "@/lib/api";
import {
  CartaoPublico,
  ErroPublico,
  botaoPrimario,
  campoPublico,
  rotuloPublico,
} from "@/components/Publico";
import { useBranding } from "@/lib/branding";

import { tx } from "@/lib/i18n";
export default function InviteAcceptPage() {
  const { passkeyRequired, brandName } = useBranding();
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"loading" | "valid" | "invalid">(
    "loading",
  );
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await validateInvite(token);
        if (cancelled) return;
        if (info.valid) {
          setStatus("valid");
          if (info.email) {
            setInviteEmail(info.email);
            setEmail(info.email);
          }
        } else {
          setStatus("invalid");
        }
      } catch {
        if (!cancelled) setStatus("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const result = await acceptInvite({ token, name, email, password });
      if (!result.success) {
        setError(tx("Não deu para criar a conta."));
        return;
      }
      const signInResult = await signIn.email({ email, password });
      if (signInResult.error) {
        setError(
          tx(
            "A conta foi criada, mas o login não entrou. Vá para a tela de login.",
          ),
        );
        return;
      }
      // Redirect home regardless of passkey gating; the auth guard will
      // bounce to /setup-passkey if needed once the session is loaded.
      // This avoids a race where /api/config hasn't responded yet and we
      // end up stuck on /invite/ while passkeyRequired flips.
      void passkeyRequired;
      window.location.href = "/";
    } catch (err: any) {
      setError(err?.message || tx("Não deu para aceitar o convite."));
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading") {
    return (
      <p className="text-sm text-text-tertiary">
        {tx("Conferindo o convite…")}
      </p>
    );
  }

  if (status === "invalid") {
    return (
      <CartaoPublico
        titulo={tx("Convite inválido")}
        subtitulo={tx(
          "Este link expirou, já foi usado ou não existe. Peça outro a quem convidou você.",
        )}
      >
        <a href="/login" className={botaoPrimario}>
          {tx("Ir para o login")}
        </a>
      </CartaoPublico>
    );
  }

  return (
    <CartaoPublico
      titulo={tx("Entrar em {0}", brandName)}
      subtitulo={tx("Crie sua conta para começar.")}
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>{tx("Nome")}</span>
          <input
            id="invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            className={campoPublico}
          />
        </label>
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>{tx("E-mail")}</span>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            disabled={!!inviteEmail}
            className={campoPublico + (inviteEmail ? " opacity-60" : "")}
          />
        </label>
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>{tx("Senha")}</span>
          <input
            id="invite-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className={campoPublico}
          />
          <span className="text-xs text-text-tertiary">
            {tx("Pelo menos 8 caracteres.")}
          </span>
        </label>
        {error && <ErroPublico>{error}</ErroPublico>}
        <button type="submit" className={botaoPrimario} disabled={loading}>
          {loading ? tx("Criando a conta…") : tx("Criar conta")}
        </button>
      </form>
    </CartaoPublico>
  );
}
