import { useState, useEffect, useMemo, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  X,
  Send,
  Clock,
  Reply as ReplyIcon,
  FileText,
  Save,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import ThreadMessage from "@/components/ThreadMessage";
import AttachmentPicker from "@/components/AttachmentPicker";
import AttachmentChips from "@/components/AttachmentChips";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import {
  replyToEmail,
  fetchTemplates,
  fetchEmail,
  fetchPersonEmails,
  fetchDraft,
  saveDraft,
  deleteDraft,
  type EmailTemplate,
  type Email,
  type CcEntry,
} from "@/lib/api";
import { dispatchEmailSent } from "@/lib/email-events";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import {
  apagarRascunho,
  lerRascunho,
  notificarRascunhos,
  rascunhoVazio,
  salvarRascunho,
  type Rascunho,
} from "@/lib/rascunho";
import { useSession } from "@/lib/auth-client";
import { proximoHorarioComercial } from "@worker/lib/horario-comercial";
import { rotuloHorario } from "@/lib/datas";
import { analyzeTemplateClient, chipLabel } from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

interface ReplyComposerProps {
  emailId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  senderIdentities: Array<{
    email: string;
    displayName: string | null;
    signatureHtml?: string | null;
  }>;
  /** Domains we treat as "internal" — used for CC chip color. */
  internalDomains?: string[];
  onClose: () => void;
  onSent: () => void;
}

type Tab = "freeform" | "template";

export default function ReplyComposer(props: ReplyComposerProps) {
  const { data: sessao } = useSession();
  const userId = sessao?.user?.id;
  if (!userId) return null;
  return (
    <ReplyComposerDoUsuario
      key={`${userId}:${props.emailId}`}
      {...props}
      userId={userId}
    />
  );
}

function ReplyComposerDoUsuario({
  emailId,
  personName,
  personEmail,
  recipients,
  senderIdentities,
  internalDomains = [],
  onClose,
  onSent,
  userId,
}: ReplyComposerProps & { userId: string }) {
  const [tab, setTab] = useState<Tab>("freeform");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [cc, setCc] = useState<CcEntry[]>([]);
  const [bodyHtml, setBodyHtml] = useState("");
  // Plain-text mirror of the editor, kept in lockstep with bodyHtml so the
  // reply ships a `text/plain` part and renders as a normal chat bubble.
  const [bodyText, setBodyText] = useState("");
  // Stored separately from the body so swapping `From` mid-reply replaces
  // the trailing signature without touching what the user has typed.
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const totalAttachmentBytes = files.reduce((s, f) => s + f.size, 0);
  // Compact tray vs. full-viewport. Toggled by the maximize button.
  const [fullscreen, setFullscreen] = useState(false);

  // --- rascunho ------------------------------------------------------------
  // O servidor e a verdade; o localStorage (por usuario) e so backup do que
  // ainda nao foi salvo la. Sem autosave remoto: quem grava no servidor e o
  // botao "Salvar rascunho", uma gravacao por vez, e o selo compara o snapshot
  // atual ao ultimo confirmado. Assim nao existe PUT antes do GET, PUT fora de
  // ordem, nem rascunho ressuscitando depois do envio.
  type Conteudo = Omit<Rascunho, "em">;
  const snapshot = (c: Conteudo) =>
    JSON.stringify({
      fromAddress: c.fromAddress,
      cc: c.cc,
      bodyHtml: c.bodyHtml,
      bodyText: c.bodyText,
    });
  const conteudo: Conteudo = { fromAddress, cc, bodyHtml, bodyText };
  const conteudoJson = snapshot(conteudo);
  // "carregando" bloqueia o editor e o Salvar ate o GET responder;
  // "indisponivel" = GET falhou: Salvar segue bloqueado (nao sobrescrever um
  // remoto que nao conseguimos ler), o texto fica na tela e no backup local, e
  // ha um "tentar de novo".
  const [remoto, setRemoto] = useState<
    "carregando" | "pronto" | "indisponivel"
  >("carregando");
  const [tentativa, setTentativa] = useState(0);
  /** Snapshot do ultimo conteudo que o servidor confirmou; null = nao ha rascunho la. */
  const [confirmado, setConfirmado] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState("");
  const ocupado = salvando || sending;
  // Backup local que divergiu do remoto: fica guardado e so entra no editor por
  // clique — o servidor vence, mas o texto pendente nao se perde.
  const [backupPendente, setBackupPendente] = useState<Rascunho | null>(null);
  // Um rascunho (local ou remoto) entrou no editor: o prefill de "reply-all"
  // com o CC do original nao pode passar por cima dele, nem quando o CC
  // restaurado e vazio.
  const restaurouRascunho = useRef(false);

  function aplicar(r: Conteudo) {
    // Preserve a identidade salva; a guarda de envio explica se ela foi removida.
    if (r.fromAddress) setFromAddress(r.fromAddress);
    setCc((r.cc as CcEntry[]) ?? []);
    setBodyHtml(r.bodyHtml ?? "");
    setBodyText(r.bodyText ?? "");
    restaurouRascunho.current = true;
  }

  useEffect(() => {
    if (!userId) return;
    let cancelado = false;
    setRemoto("carregando");
    setErroSalvar("");
    const local = lerRascunho(userId, emailId);
    fetchDraft(emailId)
      .then((servidor) => {
        if (cancelado) return;
        if (servidor) {
          const c: Conteudo = {
            fromAddress: servidor.fromAddress,
            cc: servidor.cc,
            bodyHtml: servidor.bodyHtml,
            bodyText: servidor.bodyText,
          };
          aplicar(c);
          setConfirmado(snapshot(c));
          if (local && snapshot(local) !== snapshot(c)) {
            setBackupPendente(local);
          } else if (local) {
            apagarRascunho(userId, emailId);
          }
        } else {
          setConfirmado(null);
          if (local) aplicar(local);
        }
        setRemoto("pronto");
      })
      .catch((err) => {
        if (cancelado) return;
        console.warn("Failed to load server draft", err);
        if (local) aplicar(local);
        setRemoto("indisponivel");
      });
    return () => {
      cancelado = true;
    };
  }, [emailId, userId, tentativa]);

  const alterado =
    confirmado !== null
      ? conteudoJson !== confirmado
      : !rascunhoVazio(conteudo);

  // Grave após cada edição: trocar de mensagem também pode desmontar o editor.
  // Um backup divergente só é substituído após a escolha explícita do usuário.
  useEffect(() => {
    if (remoto === "carregando" || backupPendente || ocupado) return;
    if (!alterado) apagarRascunho(userId, emailId);
    else salvarRascunho(userId, emailId, conteudo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    userId,
    emailId,
    remoto,
    conteudoJson,
    alterado,
    backupPendente,
    ocupado,
  ]);

  async function salvarNoServidor() {
    if (ocupado || backupPendente || remoto !== "pronto") return;
    setSalvando(true);
    setErroSalvar("");
    const alvo = conteudoJson;
    const c = conteudo;
    try {
      if (rascunhoVazio(c)) {
        if (confirmado !== null) await deleteDraft(emailId);
        setConfirmado(null);
      } else {
        await saveDraft(emailId, {
          fromAddress: c.fromAddress,
          cc: (c.cc as CcEntry[]).length > 0 ? (c.cc as CcEntry[]) : undefined,
          bodyHtml: c.bodyHtml,
          bodyText: c.bodyText,
        });
        setConfirmado(alvo);
      }
      // O que esta no servidor nao precisa de backup.
      apagarRascunho(userId, emailId);
      setBackupPendente(null);
      notificarRascunhos();
    } catch (err) {
      console.warn("Failed to save server draft", err);
      setErroSalvar(
        tx(
          "Não foi possível salvar o rascunho no servidor. O texto continua aqui e no backup deste navegador.",
        ),
      );
    } finally {
      setSalvando(false);
    }
  }

  // Fechar grava o backup local NA HORA, sem esperar o debounce — e o caminho
  // "fechei e perdi" que o backup existe para cobrir. Nunca grava no servidor.
  function fechar() {
    if (ocupado) return;
    if (!backupPendente && remoto !== "carregando") {
      if (!alterado) apagarRascunho(userId, emailId);
      else salvarRascunho(userId, emailId, conteudo);
    }
    onClose();
  }

  // Caixa que recebe mas nao tem identidade de envio (login@…): o rascunho
  // salva normalmente, o envio fica bloqueado e explicado. O remetente NUNCA e
  // trocado por baixo do usuario.
  const identidadeEnvia = senderIdentities.some(
    (s) => s.email.toLowerCase() === fromAddress.toLowerCase(),
  );
  // Mesmo modulo do servidor (alias @worker) — ver ComposeModal.
  const rotuloSlot = rotuloHorario(proximoHorarioComercial(Date.now()));

  // Sync the signature trail to the active From inbox.
  useEffect(() => {
    if (!fromAddress) {
      setSignatureHtml(null);
      return;
    }
    const match = senderIdentities.find((s) => s.email === fromAddress);
    setSignatureHtml(match?.signatureHtml ?? null);
  }, [fromAddress, senderIdentities]);

  // Sanitize the signature once per change. Server sanitizes on write
  // too; this is defense-in-depth for the browser render path
  // (dangerouslySetInnerHTML) and for the outbound body we POST.
  const safeSignatureHtml = useMemo(
    () => (signatureHtml ? sanitizeEmailHtml(signatureHtml) : null),
    [signatureHtml],
  );

  // Thread context — the email being replied to + prior messages from the
  // same person/inbox so the user can reference them while drafting.
  const [originalEmail, setOriginalEmail] = useState<Email | null>(null);
  const [threadEmails, setThreadEmails] = useState<Email[]>([]);
  const [threadExpanded, setThreadExpanded] = useState(false);
  // Surface failure to load the original. The previous silent `.catch`
  // masked a real bug — the server didn't look up sent_emails, so
  // clicking Reply on our own outgoing message rendered an empty
  // composer with no warning.
  const [contextError, setContextError] = useState(false);

  // Template state
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  // Load the email being replied to + the surrounding thread on mount.
  // Pre-populate CC from the original message so "reply-all" semantics
  // are the default — users can still trim chips before sending.
  useEffect(() => {
    let cancelled = false;
    setContextError(false);
    fetchEmail(emailId)
      .then(async (email) => {
        if (cancelled) return;
        setOriginalEmail(email);
        if (email.cc && email.cc.length > 0 && !restaurouRascunho.current) {
          // Drop our own inbox addresses from the suggested CC list — we
          // don't want to CC ourselves on a reply we're sending.
          const ours = new Set(recipients.map((r) => r.toLowerCase()));
          setCc(email.cc.filter((c) => !ours.has(c.email.toLowerCase())));
        }
        // If we have a personId, fetch the person's recent emails in this inbox.
        if (email.personId) {
          try {
            const recipient = email.recipient ?? email.fromAddress ?? undefined;
            const res = await fetchPersonEmails(email.personId, {
              recipient,
              limit: 12,
            });
            if (!cancelled) setThreadEmails(res.emails);
          } catch (err) {
            // Surface to console so a future regression isn't invisible.
            console.warn("Failed to load surrounding thread", err);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // The composer still works — the user can type and send. But
        // they'd have no idea why the "what you're replying to" panel
        // is missing without this notice.
        console.warn("Failed to load reply context", err);
        setContextError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [emailId, recipients]);

  const selectedTemplate =
    templates.find((t) => t.slug === selectedSlug) ?? null;

  // Only top-level names, same contract the send API validates — names
  // scoped inside a {{#section}} resolve per item, not from this form, so
  // they're deliberately excluded (see src/lib/template-syntax.ts).
  const templateAnalysis = useMemo(() => {
    if (!selectedTemplate) return null;
    try {
      return analyzeTemplateClient(
        selectedTemplate.subject,
        selectedTemplate.bodyHtml,
      );
    } catch {
      // A stored template shouldn't fail to parse, but if one somehow does,
      // fall back to no prompts rather than crashing the composer.
      return null;
    }
  }, [selectedTemplate]);
  const requiredVars = templateAnalysis?.required ?? [];
  // A required name that's actually a section (e.g. {{#items}}) needs an
  // array of objects, not the plain string this form's inputs collect — used
  // below to warn that such a template can't be filled in from here. The
  // chip text itself comes from the shared `chipLabel`.
  const sectionVarNames = useMemo(
    () => new Set((templateAnalysis?.sections ?? []).map((s) => s.name)),
    [templateAnalysis],
  );

  useEffect(() => {
    if (!selectedTemplate) return;
    const vars: Record<string, string> = {};
    for (const v of requiredVars) {
      if (v.toLowerCase() === "name" && personName) vars[v] = personName;
      else if (v.toLowerCase() === "email") vars[v] = personEmail;
      else vars[v] = templateVars[v] ?? "";
    }
    setTemplateVars(vars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlug, requiredVars.join(",")]);

  useEffect(() => {
    if (tab !== "template" || templates.length > 0) return;
    setTemplatesLoading(true);
    setTemplatesError("");
    fetchTemplates()
      .then(setTemplates)
      .catch(() => setTemplatesError(tx("Não deu para carregar os modelos.")))
      .finally(() => setTemplatesLoading(false));
  }, [tab, templates.length]);

  async function handleSend(agendar = false) {
    if (!identidadeEnvia || ocupado || backupPendente || remoto !== "pronto")
      return;
    setSending(true);
    setError("");
    const ccPayload = cc.length > 0 ? cc : undefined;
    try {
      if (tab === "freeform") {
        // Wrap the signature in a marker div so the chat-feed "hide
        // signatures" toggle can strip it cleanly. Skip when the inbox has
        // none configured. Templates already include their own boilerplate
        // so we don't append.
        const finalBody = safeSignatureHtml
          ? `${bodyHtml}<div data-signature>${safeSignatureHtml}</div>`
          : bodyHtml;
        await replyToEmail(emailId, {
          ...(agendar ? { agendarHorarioComercial: true } : {}),
          bodyHtml: finalBody,
          ...(bodyText.trim() ? { bodyText } : {}),
          fromAddress,
          ...(ccPayload ? { cc: ccPayload } : {}),
          ...(files.length > 0
            ? { files: files.map((file) => ({ file })) }
            : {}),
        });
      } else {
        if (!selectedSlug) {
          setError(tx("Escolha um modelo."));
          setSending(false);
          return;
        }
        await replyToEmail(emailId, {
          ...(agendar ? { agendarHorarioComercial: true } : {}),
          templateSlug: selectedSlug,
          variables: templateVars,
          fromAddress,
          ...(ccPayload ? { cc: ccPayload } : {}),
          ...(files.length > 0
            ? { files: files.map((file) => ({ file })) }
            : {}),
        });
      }
      setFiles([]);
      // Notify the rest of the app — PersonDetail uses this to
      // auto-switch the active inbox tab when the user replied from a
      // different inbox than the one they were viewing.
      dispatchEmailSent({
        fromAddress,
        to: personEmail,
        origin: "reply",
      });
      // So aqui, com o envio confirmado, o rascunho deixa de existir. Se o
      // DELETE falhar o servidor fica com uma copia a mais — melhor que
      // apagar antes e o envio falhar depois.
      if (userId) apagarRascunho(userId, emailId);
      if (confirmado !== null) {
        deleteDraft(emailId)
          .catch((err) => console.warn("Failed to discard sent draft", err))
          .finally(() => notificarRascunhos());
      }
      onSent();
      onClose();
    } catch {
      setError(tx("Não deu para enviar a resposta. Tente de novo."));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  const recipientLabel = personName
    ? `${personName} <${personEmail}>`
    : personEmail;

  return (
    // Non-modal tray (Gmail-style): page behind stays interactive, only
    // X / Esc closes. Same shape as ComposeModal so the two feel like
    // one component family.
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(v) => !v && fechar()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onKeyDown={handleKeyDown}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          data-testid="reply-composer"
          className={trayContentClass({ fullscreen, width: "compose" })}
        >
          {/* Slim single-row header. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 pl-4">
            <div className="flex min-w-0 items-center gap-2">
              <ReplyIcon
                size={14}
                className="shrink-0 text-primary"
                aria-hidden
              />
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {tx("Responder ·")} {recipientLabel}
              </DialogPrimitive.Title>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <ModePillToggle tab={tab} onTab={setTab} />
              <TrayMaximizeButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((v) => !v)}
              />
              <DialogPrimitive.Close
                disabled={ocupado}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                aria-label={tx("Fechar")}
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Compact metadata: From / To / Cc. */}
          <div
            inert={ocupado || !!backupPendente || remoto === "carregando"}
            className="shrink-0 divide-y divide-border/60 border-b border-border bg-bg-subtle/30"
          >
            <TrayMetaRow label={tx("De")}>
              <select
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                className="w-full bg-transparent py-2 pr-3 text-sm text-text-primary outline-none"
              >
                {Array.from(
                  new Set([fromAddress, ...recipients].filter(Boolean)),
                ).map((r) => (
                  <option key={r} value={r}>
                    {getFromLabel(r, senderIdentities)}
                  </option>
                ))}
              </select>
            </TrayMetaRow>
            <TrayMetaRow label={tx("Para")}>
              <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                {recipientLabel}
                {originalEmail?.replyTo &&
                  originalEmail.replyTo.toLowerCase() !==
                    personEmail.toLowerCase() && (
                    <span
                      data-testid="reply-to-hint"
                      className="ml-2 text-xs font-light text-warning-text"
                      title={tx(
                        "O e-mail original pede resposta para outro endereço (Reply-To). A resposta vai para a pessoa da conversa.",
                      )}
                    >
                      {tx("Reply-To:")} {originalEmail.replyTo}
                    </span>
                  )}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label={tx("Cc")}>
              <CcInput
                value={cc}
                onChange={setCc}
                internalDomains={internalDomains}
                testId="reply-cc-input"
              />
            </TrayMetaRow>
          </div>

          {/* Avisos de rascunho e de envio — valem nas duas abas. */}
          {!identidadeEnvia && (
            <div
              role="status"
              data-testid="reply-send-unavailable"
              className="shrink-0 border-b border-warning-border bg-warning-bg px-4 py-2 text-xs text-warning-text"
            >
              <strong>{fromAddress}</strong>{" "}
              {tx(
                "recebe e-mails, mas ainda não tem identidade de envio configurada. Você pode salvar o rascunho; enviar fica indisponível até a identidade existir. O remetente não foi trocado.",
              )}
            </div>
          )}
          {remoto === "indisponivel" && (
            <div
              role="status"
              data-testid="reply-draft-unavailable"
              className="flex shrink-0 items-center gap-3 border-b border-warning-border bg-warning-bg px-4 py-2 text-xs text-warning-text"
            >
              <span className="flex-1">
                {tx(
                  "Não foi possível consultar o rascunho no servidor. O que você escrever fica só neste navegador até a consulta funcionar.",
                )}
              </span>
              <button
                type="button"
                onClick={() => setTentativa((n) => n + 1)}
                className="shrink-0 rounded-[6px] border border-current/30 px-2 py-0.5 font-medium hover:bg-amber-200/40"
              >
                {tx("Tentar de novo")}
              </button>
            </div>
          )}
          {backupPendente && (
            <div
              role="status"
              data-testid="reply-backup-pending"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-subtle/60 px-4 py-2 text-xs text-text-secondary"
            >
              <span className="flex-1">
                {tx(
                  "Este navegador guardou um texto não salvo, diferente do rascunho do servidor. O do servidor está no editor.",
                )}
              </span>
              <button
                type="button"
                data-testid="reply-backup-use"
                onClick={() => {
                  aplicar(backupPendente);
                  setBackupPendente(null);
                }}
                className="rounded-[6px] border border-border bg-card px-2 py-0.5 font-medium text-text-primary hover:bg-bg-muted"
              >
                {tx("Usar texto deste navegador")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (userId) apagarRascunho(userId, emailId);
                  setBackupPendente(null);
                }}
                className="rounded-[6px] px-2 py-0.5 font-medium text-text-tertiary hover:text-text-primary"
              >
                {tx("Descartar")}
              </button>
            </div>
          )}
          {/* Body — flex-1, no min-height pin. */}
          <div
            inert={ocupado || !!backupPendente}
            className="smooth-scroll flex min-h-0 flex-1 flex-col overflow-y-auto bg-card"
          >
            {tab === "freeform" ? (
              <div className="flex flex-1 flex-col gap-3 px-4 py-3 sm:px-5">
                {/* Thread context — what you're replying to */}
                {originalEmail && (
                  <ThreadContext
                    original={originalEmail}
                    thread={threadEmails}
                    expanded={threadExpanded}
                    onToggle={() => setThreadExpanded((v) => !v)}
                  />
                )}
                {!originalEmail && contextError && (
                  <div
                    role="status"
                    className="rounded-[8px] border border-warning-border bg-warning-bg px-4 py-2.5 text-xs text-warning-text"
                  >
                    {tx(
                      "Não deu para carregar a mensagem original; ela pode ter sido excluída. A resposta ainda pode ser enviada.",
                    )}
                  </div>
                )}
                <div className="flex-1">
                  <AttachmentPicker
                    enableDragDrop
                    buttonClassName="hidden"
                    onFilesAdded={(added) =>
                      setFiles((prev) => [...prev, ...added])
                    }
                  >
                    {remoto === "carregando" ? (
                      <p
                        data-testid="reply-draft-loading"
                        className="py-3 text-sm text-text-tertiary"
                      >
                        {tx("Consultando rascunho…")}
                      </p>
                    ) : (
                      <TiptapEditor
                        content={bodyHtml}
                        onUpdate={(html, text) => {
                          setBodyHtml(html);
                          setBodyText(text);
                        }}
                        placeholder={tx("Escreva a resposta…")}
                      />
                    )}
                    <AttachmentChips
                      files={files}
                      capBytes={ATTACHMENT_CAP_BYTES}
                      onRemove={(idx) =>
                        setFiles((prev) => prev.filter((_, i) => i !== idx))
                      }
                    />
                    {safeSignatureHtml && (
                      <div
                        data-signature
                        data-testid="reply-signature-preview"
                        className="mt-4 border-t border-border/60 pt-3 opacity-70"
                        // Pre-sanitized via sanitizeEmailHtml above.
                        dangerouslySetInnerHTML={{ __html: safeSignatureHtml }}
                      />
                    )}
                  </AttachmentPicker>
                </div>
              </div>
            ) : (
              <div className="space-y-4 px-4 py-3 sm:px-5">
                {templatesLoading ? (
                  <p className="text-sm font-light text-text-tertiary">
                    {tx("Carregando modelos…")}
                  </p>
                ) : templatesError ? (
                  <p className="text-sm text-destructive">{templatesError}</p>
                ) : (
                  <>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                        {tx("Modelo")}
                      </label>
                      <select
                        value={selectedSlug}
                        onChange={(e) => setSelectedSlug(e.target.value)}
                        className="w-full rounded-[8px] border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
                      >
                        <option value="">{tx("Escolha um modelo…")}</option>
                        {templates.map((t) => (
                          <option key={t.slug} value={t.slug}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedTemplate && (
                      <>
                        <div className="rounded-[8px] bg-bg-subtle/60 p-4 ring-1 ring-border">
                          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                            {tx("Assunto")}
                          </p>
                          <p className="text-sm font-medium text-text-primary">
                            {selectedTemplate.subject}
                          </p>
                          <div className="mt-3 border-t border-border pt-3">
                            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                              {tx("Prévia do corpo")}
                            </p>
                            <div
                              className="prose prose-sm max-h-48 max-w-none overflow-auto text-sm text-text-secondary"
                              dangerouslySetInnerHTML={{
                                __html: sanitizeEmailHtml(
                                  selectedTemplate.bodyHtml,
                                ),
                              }}
                            />
                          </div>
                        </div>

                        {requiredVars.length > 0 && (
                          <div>
                            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                              {tx("Variáveis")}
                            </p>
                            <div className="space-y-2">
                              {requiredVars.map((v) => (
                                <div
                                  key={v}
                                  className="grid grid-cols-[120px_1fr] items-center gap-3"
                                >
                                  <label className="truncate font-mono text-xs text-text-tertiary">
                                    {templateAnalysis
                                      ? chipLabel(v, templateAnalysis)
                                      : `{{${v}}}`}
                                  </label>
                                  <input
                                    value={templateVars[v] ?? ""}
                                    onChange={(e) =>
                                      setTemplateVars((prev) => ({
                                        ...prev,
                                        [v]: e.target.value,
                                      }))
                                    }
                                    className="rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
                                  />
                                </div>
                              ))}
                            </div>
                            {[...sectionVarNames].some((n) =>
                              requiredVars.includes(n),
                            ) && (
                              <p className="mt-2 text-[11px] font-light text-text-tertiary">
                                {tx(
                                  "Variáveis de seção (#) pedem uma lista de objetos; este formulário só manda texto, então envie essas pela API.",
                                )}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Slim footer — single row, send + cancel + hint. */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-2.5 sm:px-5">
            <div className="min-w-0 truncate text-[11px] text-text-tertiary">
              {error ? (
                <span className="text-destructive" role="alert">
                  {error}
                </span>
              ) : (
                <span className="hidden sm:inline">
                  <kbd className="rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                    {tx("Ctrl")}
                  </kbd>
                  <kbd className="ml-1 rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                    {tx("Enter")}
                  </kbd>{" "}
                  {tx("envia")}
                </span>
              )}
            </div>
            {/* Selo de rascunho: compara o que esta na tela ao ultimo snapshot
                que o servidor confirmou. Nunca diz "salvo" por conta de um
                debounce ou de uma gravacao que falhou. Diz tambem o que NAO se
                salva (anexos), porque o risco e o usuario supor que o PDF voltou. */}
            {(erroSalvar || confirmado !== null || alterado) && (
              <span
                data-testid="reply-draft-hint"
                data-estado={
                  erroSalvar
                    ? "falhou"
                    : salvando
                      ? "salvando"
                      : confirmado !== null && !alterado
                        ? "salvo"
                        : "alterado"
                }
                className={cn(
                  "mr-auto text-[11px] font-light",
                  erroSalvar ? "text-warning-text" : "text-text-tertiary",
                )}
              >
                {erroSalvar
                  ? erroSalvar
                  : salvando
                    ? tx("Salvando rascunho…")
                    : confirmado !== null && !alterado
                      ? tx("Rascunho salvo")
                      : confirmado !== null
                        ? tx("Alterações não salvas · backup neste navegador")
                        : tx("Não salvo · backup neste navegador")}
                {files.length > 0 ? tx(" · anexos não são salvos") : ""}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="reply-save-draft"
                onClick={salvarNoServidor}
                disabled={
                  remoto !== "pronto" ||
                  ocupado ||
                  !!backupPendente ||
                  !alterado
                }
                title={
                  remoto === "carregando"
                    ? tx("Consultando o rascunho no servidor…")
                    : remoto === "indisponivel"
                      ? tx(
                          "Sem acesso ao servidor: não dá para salvar sem antes ler o que há lá",
                        )
                      : undefined
                }
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save size={12} />
                {salvando
                  ? tx("Salvando…")
                  : rascunhoVazio(conteudo) && confirmado !== null
                    ? tx("Apagar rascunho")
                    : tx("Salvar rascunho")}
              </button>
              <AttachmentPicker
                onFilesAdded={(added) =>
                  setFiles((prev) => [...prev, ...added])
                }
                buttonClassName="inline-flex items-center justify-center rounded-[6px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
              />
              <button
                type="button"
                onClick={fechar}
                disabled={ocupado}
                className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                {tx("Cancelar")}
              </button>
              <button
                type="button"
                data-testid="reply-schedule-button"
                onClick={() => handleSend(true)}
                title={
                  identidadeEnvia
                    ? tx(
                        "Fica na fila e sai {0}, em horário comercial",
                        rotuloSlot,
                      )
                    : tx("Esta caixa ainda não tem identidade de envio")
                }
                disabled={
                  ocupado ||
                  remoto !== "pronto" ||
                  !!backupPendente ||
                  !identidadeEnvia ||
                  totalAttachmentBytes > ATTACHMENT_CAP_BYTES
                }
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Clock size={12} />
                {sending ? "…" : tx("Agendar {0}", rotuloSlot)}
              </button>
              <button
                type="button"
                onClick={() => handleSend()}
                data-testid="reply-send-button"
                title={
                  identidadeEnvia
                    ? undefined
                    : tx("Esta caixa ainda não tem identidade de envio")
                }
                disabled={
                  ocupado ||
                  remoto !== "pronto" ||
                  !!backupPendente ||
                  !identidadeEnvia ||
                  totalAttachmentBytes > ATTACHMENT_CAP_BYTES
                }
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} />
                {sending ? tx("Enviando…") : tx("Enviar resposta")}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Compact Freeform/Template toggle that lives in the slim header
 * instead of taking its own row. Mirrors the pill-toggle aesthetic
 * used by the Templates editor's view switch.
 */
function ModePillToggle({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div className="mr-1 inline-flex rounded-[6px] bg-bg-muted/70 p-0.5 ring-1 ring-border">
      <ModePill
        active={tab === "freeform"}
        onClick={() => onTab("freeform")}
        icon={Sparkles}
        label={tx("Texto livre")}
      />
      <ModePill
        active={tab === "template"}
        onClick={() => onTab("template")}
        icon={FileText}
        label={tx("Modelo")}
      />
    </div>
  );
}

function ModePill({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-all",
        active
          ? "bg-card text-text-primary shadow-sm"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      <Icon size={11} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

interface ThreadContextProps {
  original: Email;
  thread: Email[];
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Renders the email being replied to with a collapsible older thread above
 * it. Lets the user reference the conversation while drafting without
 * leaving the composer.
 */
function ThreadContext({
  original,
  thread,
  expanded,
  onToggle,
}: ThreadContextProps) {
  // Older messages (everything except the original), oldest → newest.
  const olderEmails = useMemo(() => {
    const others = thread.filter((e) => e.id !== original.id);
    return [...others].sort((a, b) => a.timestamp - b.timestamp);
  }, [thread, original.id]);

  return (
    <div className="rounded-[8px] bg-bg-subtle/60 ring-1 ring-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ReplyIcon size={13} className="shrink-0 text-text-tertiary" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            {tx("Respondendo a")}
          </span>
          {original.subject && (
            <span className="truncate text-xs font-medium text-text-secondary">
              · {original.subject}
            </span>
          )}
        </div>
        {olderEmails.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            {expanded ? (
              <>
                <ChevronUp size={12} />
                {tx("Esconder histórico")}
              </>
            ) : (
              <>
                <ChevronDown size={12} />
                {tx("Mostrar")} {olderEmails.length} {tx("anteriores")}
              </>
            )}
          </button>
        )}
      </div>

      <div className="max-h-[360px] overflow-y-auto smooth-scroll">
        {expanded && olderEmails.length > 0 && (
          <div className="divide-y divide-border/60">
            {olderEmails.map((e) => (
              <ThreadMessage key={e.id} email={e} muted />
            ))}
          </div>
        )}
        <div className={olderEmails.length > 0 ? "border-t border-border" : ""}>
          <ThreadMessage email={original} highlight />
        </div>
      </div>
    </div>
  );
}
