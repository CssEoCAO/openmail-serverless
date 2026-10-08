import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import {
  CartaoPublico,
  ErroPublico,
  botaoPrimario,
  campoPublico,
  rotuloPublico,
} from "@/components/Publico";
import { useBranding } from "@/lib/branding";

type Status = "checking" | "available" | "unavailable" | "migration-required";

type SetupStatusResponse = {
  setupRequired?: boolean;
  error?: string;
  code?: string;
  command?: string;
};

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { passkeyRequired } = useBranding();
  const [status, setStatus] = useState<Status>("checking");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [error, setError] = useState("");
  const [migrationRequired, setMigrationRequired] =
    useState<SetupStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as SetupStatusResponse;
        if (cancelled) return;
        if (!res.ok && data.code === "DATABASE_MIGRATION_REQUIRED") {
          setMigrationRequired(data);
          setStatus("migration-required");
          return;
        }
        setStatus(data.setupRequired ? "available" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, bootstrapToken }),
      });
      if (!res.ok) {
        const data = (await res
          .json()
          .catch(() => ({}))) as SetupStatusResponse;
        setError(data.error || "Não deu para criar a conta.");
        if (res.status === 503 && data.code === "DATABASE_MIGRATION_REQUIRED") {
          setMigrationRequired(data);
          setStatus("migration-required");
        }
        return;
      }
      const result = await signIn.email({ email, password });
      if (result.error) {
        navigate("/login", { replace: true });
        return;
      }
      window.location.href = passkeyRequired ? "/setup-passkey" : "/";
    } catch {
      setError("Não deu para criar a conta.");
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") {
    return <p className="text-sm text-text-tertiary">Carregando…</p>;
  }

  if (status === "migration-required") {
    return (
      <CartaoPublico
        titulo="Falta preparar o banco"
        subtitulo={
          migrationRequired?.error ||
          "O banco de produção ainda não recebeu as migrações."
        }
      >
        <code className="block rounded-[6px] border border-border bg-bg-subtle px-3 py-2 text-xs text-text-primary">
          {migrationRequired?.command || "yarn db:migrate:prod"}
        </code>
        <p className="mt-3 text-xs text-text-tertiary">
          Rode o comando acima e recarregue esta página.
        </p>
      </CartaoPublico>
    );
  }

  if (status === "unavailable") {
    return (
      <CartaoPublico
        titulo="Configuração já feita"
        subtitulo="Já existe uma conta de administrador. Entre com ela."
      >
        <button className={botaoPrimario} onClick={() => navigate("/login")}>
          Ir para o login
        </button>
      </CartaoPublico>
    );
  }

  return (
    <CartaoPublico
      titulo="Primeiro acesso"
      subtitulo="Crie a conta de administrador para começar."
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>Código de instalação</span>
          <input
            id="bootstrap-token"
            type="password"
            autoComplete="off"
            required
            value={bootstrapToken}
            onChange={(e) => setBootstrapToken(e.target.value)}
            className={campoPublico}
          />
          <span className="text-xs text-text-tertiary">
            Código temporário de quem instalou (scripts/prepare-bootstrap.mjs).
          </span>
        </label>
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>Nome</span>
          <input
            id="onboarding-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            className={campoPublico}
          />
        </label>
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>E-mail</span>
          <input
            id="onboarding-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className={campoPublico}
          />
        </label>
        <label className="grid gap-1.5">
          <span className={rotuloPublico}>Senha</span>
          <input
            id="onboarding-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className={campoPublico}
          />
          <span className="text-xs text-text-tertiary">
            Pelo menos 8 caracteres.
          </span>
        </label>
        {error && <ErroPublico>{error}</ErroPublico>}
        <button type="submit" className={botaoPrimario} disabled={loading}>
          {loading ? "Criando a conta…" : "Criar administrador"}
        </button>
      </form>
    </CartaoPublico>
  );
}
