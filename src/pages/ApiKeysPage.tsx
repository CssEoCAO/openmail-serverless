import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check, Key, RefreshCw, Trash2 } from "lucide-react";
import {
  fetchApiKeyInfo,
  generateApiKey,
  revokeApiKey,
  fetchWebhookConfig,
  saveWebhookConfig,
  testWebhook,
} from "@/lib/api";
import type { ApiKeyInfo } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import PageHeader, { PageContainer } from "@/components/PageHeader";

import { LOCALE, tx } from "@/lib/i18n";
export default function ApiKeysPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    "regenerate" | "revoke" | null
  >(null);

  useEffect(() => {
    fetchApiKeyInfo()
      .then((keyRes) => setKeyInfo(keyRes.key))
      .finally(() => setLoading(false));
  }, []);

  async function handleGenerate() {
    const res = await generateApiKey();
    setNewKey(res.key);
    setKeyInfo({ prefix: res.prefix, createdAt: res.createdAt });
    setConfirmAction(null);
  }

  async function handleRevoke() {
    await revokeApiKey();
    setKeyInfo(null);
    setNewKey(null);
    setConfirmAction(null);
  }

  function handleCopy() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <PageContainer>
      <PageHeader
        title={tx("Chave de API")}
        subtitle={tx(
          "Acesso por programa: enviar e-mail, cuidar de modelos, inscrever contatos e consultar a caixa.",
        )}
      />

      <div className="max-w-3xl space-y-5">
        {loading ? (
          <p className="text-sm text-text-tertiary">{tx("Carregando…")}</p>
        ) : (
          <>
            {/* Newly generated key — must copy now */}
            {newKey && (
              <div className="rounded-[8px] border border-warning-border bg-warning-bg px-4 py-3">
                <p className="mb-2 text-xs font-medium text-warning-text">
                  {tx(
                    "Sua chave de API. Copie agora: ela não aparece de novo.",
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    data-testid="api-key-revealed"
                    value={newKey}
                    className="h-9 flex-1 rounded-[6px] border border-border bg-card px-3 font-mono text-xs text-text-primary focus:outline-none"
                  />
                  <button
                    onClick={handleCopy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    {copied ? (
                      <>
                        <Check size={12} />
                        {tx("Copiado")}
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        {tx("Copiar")}
                      </>
                    )}
                  </button>
                </div>
                <button
                  onClick={() => setNewKey(null)}
                  className="mt-2 text-xs font-light text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  {tx("Concluído")}
                </button>
              </div>
            )}

            {/* Existing key */}
            {keyInfo && !newKey && (
              <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Key size={16} className="mt-0.5 text-text-tertiary" />
                    <div>
                      <p className="font-mono text-sm font-medium text-text-primary">
                        {keyInfo.prefix}
                      </p>
                      <p className="mt-0.5 text-xs font-light text-text-tertiary">
                        {tx("Criada em")}{" "}
                        {new Date(keyInfo.createdAt * 1000).toLocaleDateString(
                          LOCALE,
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setConfirmAction("regenerate")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      <RefreshCw size={12} />
                      {tx("Gerar outra")}
                    </button>
                    <button
                      onClick={() => setConfirmAction("revoke")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 size={12} />
                      {tx("Revogar")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {!keyInfo && !newKey && (
              <div className="rounded-[8px] bg-card p-8 text-center ring-1 ring-border">
                <p className="mb-1 text-sm font-medium text-text-primary">
                  {tx("Nenhuma chave ainda")}
                </p>
                <p className="mb-4 text-xs font-light text-text-tertiary">
                  {tx("Gere uma chave para usar a API por programa.")}
                </p>
                <button
                  onClick={handleGenerate}
                  className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {tx("Gerar chave de API")}
                </button>
              </div>
            )}

            {/* Usage */}
            <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">
                {tx("Como usar")}
              </h2>
              <p className="mb-3 text-xs font-light text-text-secondary">
                {tx("Mande a chave no cabeçalho")}{" "}
                <code className="rounded bg-bg-muted px-1 py-0.5 font-mono">
                  {tx("Authorization")}
                </code>
                .
              </p>
              <pre className="overflow-x-auto rounded-[6px] bg-bg-subtle p-3 text-[12px] font-mono text-text-secondary ring-1 ring-border">
                {`curl -H "Authorization: Bearer sk_..." \\
  ${typeof window !== "undefined" ? window.location.origin : "https://sua-instancia"}/api/people`}
              </pre>
              <p className="mt-3 text-xs font-light text-text-secondary">
                {tx("A chave dá acesso total à API como a sua conta. Veja a")}{" "}
                <a
                  href="/swagger-ui"
                  className="font-medium text-primary-ink hover:underline"
                >
                  {tx("documentação da API")}
                </a>{" "}
                {tx("com todas as rotas.")}
              </p>
            </div>

            {isAdmin && <WebhookSection />}
          </>
        )}
      </div>

      {/* Confirmation dialog */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {confirmAction === "regenerate"
                ? tx("Gerar outra chave?")
                : tx("Revogar a chave?")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            {confirmAction === "regenerate"
              ? tx(
                  "A chave atual deixa de valer e uma nova é gerada. Quem usa a antiga para de funcionar.",
                )
              : tx(
                  "A chave é apagada para sempre. Quem usa a chave para de funcionar.",
                )}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setConfirmAction(null)}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
            >
              {tx("Cancelar")}
            </button>
            <button
              onClick={
                confirmAction === "regenerate" ? handleGenerate : handleRevoke
              }
              className={`rounded-[6px] px-3 py-1.5 text-xs font-medium text-primary-foreground ${
                confirmAction === "revoke"
                  ? "bg-destructive hover:bg-destructive/90"
                  : "bg-primary hover:bg-primary/90"
              }`}
            >
              {confirmAction === "regenerate"
                ? tx("Gerar outra")
                : tx("Revogar")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

// A self-contained prompt the user can paste into any AI assistant to get
// signature-verification code in their own stack — keeps setup instructions
// in-app without shipping per-language code samples or a docs site.
const VERIFY_PROMPT = tx(
  'Escreva o código do meu endpoint de webhook para conferir os webhooks do SaaSMail.\n\nCada requisição traz o cabeçalho:\n  X-SaaSMail-Signature: sha256=<hex>\nem que <hex> é o HMAC-SHA256 do corpo EXATO da requisição (os bytes crus, antes de qualquer parse de JSON), com o segredo de assinatura do webhook como chave.\n\nO código deve:\n1. Ler o corpo cru da requisição.\n2. Calcular HMAC-SHA256(corpoCru, segredo) em hexadecimal.\n3. Comparar "sha256=" + esse hex com o cabeçalho em tempo constante.\n4. Recusar a requisição (401) se não bater.\n\nMinha stack: <sua linguagem/framework, ex.: Node/Express, Python/FastAPI, Cloudflare Workers>',
);

function WebhookSection() {
  const [url, setUrl] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState(""); // blank = unchanged on save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  function copyVerifyPrompt() {
    navigator.clipboard.writeText(VERIFY_PROMPT);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 1500);
  }

  useEffect(() => {
    fetchWebhookConfig()
      .then((cfg) => {
        setUrl(cfg.url);
        setHasSecret(cfg.hasSecret);
      })
      .catch(() => {});
  }, []);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      // Omit `secret` when the field is left blank so we don't clobber an
      // existing secret; send it only when the admin typed something.
      const body: { url: string; secret?: string } = { url: url.trim() };
      if (secret.length > 0) body.secret = secret;
      const cfg = await saveWebhookConfig(body);
      setUrl(cfg.url);
      setHasSecret(cfg.hasSecret);
      setSecret("");
      setSuccess(cfg.url ? "Webhook salvo." : "Webhook desligado.");
    } catch {
      setError(tx("Não deu para salvar o webhook."));
    } finally {
      setBusy(false);
    }
  }

  async function onClearSecret() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const cfg = await saveWebhookConfig({ url: url.trim(), secret: null });
      setHasSecret(cfg.hasSecret);
      setSecret("");
      setSuccess(tx("Segredo de assinatura apagado."));
    } catch {
      setError(tx("Não deu para apagar o segredo."));
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await testWebhook();
      setTestResult(
        res.ok
          ? `Teste entregue (HTTP ${res.status}).`
          : `Teste falhou: ${res.error ?? `HTTP ${res.status}`}.`,
      );
    } catch {
      setTestResult(tx("Teste falhou: erro na requisição."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-text-primary">
        {tx("Webhook")}
      </h2>
      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-xs font-light text-text-secondary">
          {tx("Manda um")} <code>POST</code>{" "}
          {tx(
            "para uma automação de fora (n8n, Make…) a cada e-mail que chega. Vale para todas as caixas, uma tentativa só, desligado por padrão. Com segredo de assinatura, a requisição leva o cabeçalho",
          )}{" "}
          <code>{tx("X-SaaSMail-Signature: sha256=<hmac>")}</code>{" "}
          {tx("sobre o corpo cru.")}
        </p>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="webhook-url"
            className="text-xs font-medium text-text-secondary"
          >
            {tx("URL de destino")}
          </label>
          <input
            id="webhook-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={tx("https://sua-automacao/webhook")}
            disabled={busy}
            className="h-10 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:border-primary focus:outline-none"
          />
        </div>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="webhook-secret"
            className="text-xs font-medium text-text-secondary"
          >
            {tx("Segredo de assinatura (opcional)")}
          </label>
          <input
            id="webhook-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              hasSecret
                ? tx("•••••••• (definido; em branco mantém)")
                : tx("nenhum")
            }
            disabled={busy}
            className="h-10 w-full max-w-sm rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:border-primary focus:outline-none"
          />
          {hasSecret && (
            <button
              type="button"
              onClick={onClearSecret}
              disabled={busy}
              className="text-xs font-light text-text-secondary hover:text-text-primary hover:underline disabled:opacity-60"
            >
              {tx("Apagar segredo")}
            </button>
          )}
        </div>

        {/* In-app verification guidance — no docs site, so hand the user an
            AI prompt that generates verifier code for whatever stack they use. */}
        <div className="mt-4 rounded-[6px] border border-border bg-bg-subtle p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-primary">
              {tx("Conferir a assinatura")}
            </p>
            <button
              type="button"
              onClick={copyVerifyPrompt}
              className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {promptCopied ? (
                <>
                  <Check size={12} />
                  {tx("Copiado")}
                </>
              ) : (
                <>
                  <Copy size={12} />
                  {tx("Copiar instrução")}
                </>
              )}
            </button>
          </div>
          <p className="mt-1 text-xs font-light text-text-secondary">
            {tx(
              "Para conferir a assinatura no seu receptor, cole esta instrução no seu assistente de IA: ele gera o código para a sua stack.",
            )}
          </p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[6px] bg-card p-2.5 text-[11px] font-mono leading-relaxed text-text-secondary ring-1 ring-border">
            {VERIFY_PROMPT}
          </pre>
        </div>

        {error && (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {success && <p className="mt-3 text-xs text-success">{success}</p>}
        {testResult && (
          <p className="mt-3 text-xs text-text-secondary">{testResult}</p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="rounded-[6px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? tx("Salvando…") : tx("Salvar")}
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={busy || !url.trim()}
            className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {tx("Mandar teste")}
          </button>
        </div>
      </div>
    </section>
  );
}
