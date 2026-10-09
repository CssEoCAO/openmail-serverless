import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, ShieldAlert, Trash2, Undo2 } from "lucide-react";
import {
  apagarDoSpam,
  esvaziarSpam,
  fetchSpam,
  fetchSpamEmail,
  naoEhSpam,
  type CategoriaSpam,
  type SpamItem,
} from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import EmailHtmlFrame from "@/components/EmailHtmlFrame";
import { chaves } from "@/lib/queries";
import { plural, quandoCurto } from "@/lib/datas";
import { cn } from "@/lib/utils";
import { tx } from "@/lib/i18n";

const ROTULO: Record<CategoriaSpam, string> = {
  golpe: tx("Golpe"),
  prospeccao: tx("Prospecção"),
  bloqueio: tx("Bloqueado"),
  reincidente: tx("Reincidente"),
};

function Categoria({ c }: { c: CategoriaSpam }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        c === "golpe"
          ? "bg-destructive-subtle text-destructive ring-destructive/30"
          : c === "prospeccao"
            ? "bg-warning-bg text-warning-text ring-warning-border"
            : "bg-bg-muted text-text-secondary ring-border",
      )}
    >
      {ROTULO[c]}
    </span>
  );
}

function motivo(item: SpamItem): string {
  if (item.category === "bloqueio") return tx("Remetente bloqueado");
  if (item.category === "reincidente") return tx("Já tinha ido para o Spam");
  const certeza =
    item.confidence !== null ? ` (${Math.round(item.confidence * 100)}%)` : "";
  return `${item.reason || tx("Detectado pela IA")}${certeza}`;
}

function tamanho(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

const botao =
  "inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50";

export default function SpamPage() {
  const qc = useQueryClient();
  const [itens, setItens] = useState<SpamItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const { data: detalhe, isError: erroDetalhe } = useQuery({
    queryKey: ["spam-email", aberto],
    queryFn: () => fetchSpamEmail(aberto!),
    enabled: aberto !== null,
    retry: false,
  });
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [confirmarEsvaziar, setConfirmarEsvaziar] = useState(false);

  function atualizarContagens() {
    void qc.invalidateQueries({ queryKey: chaves.stats });
  }

  async function carregar(p: number) {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetchSpam(p);
      setItens((antes) => (p === 1 ? r.data : [...antes, ...r.data]));
      setTotal(r.total);
      setPagina(p);
    } catch {
      setErro(tx("Não deu para carregar o Spam."));
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    void carregar(1);
  }, []);

  function abrir(id: string) {
    setAberto((antes) => (antes === id ? null : id));
  }

  async function devolver(item: SpamItem) {
    setOcupado(item.id);
    setAviso(null);
    try {
      const { restored } = await naoEhSpam(item.id);
      setAberto(null);
      await carregar(1);
      setAviso(
        restored === 1
          ? tx(
              "1 mensagem de {0} voltou para a caixa. Remetente liberado para as caixas restauradas.",
              item.from,
            )
          : tx(
              "{0} mensagens de {1} voltaram para a caixa. Remetente liberado para as caixas restauradas.",
              restored,
              item.from,
            ),
      );
      atualizarContagens();
      void qc.invalidateQueries({ queryKey: chaves.conversas });
      void qc.invalidateQueries({ queryKey: ["emails-pessoa"] });
    } catch {
      setErro(tx("Não deu para tirar do Spam."));
    } finally {
      setOcupado(null);
    }
  }

  async function apagar(item: SpamItem) {
    setOcupado(item.id);
    setAviso(null);
    try {
      await apagarDoSpam(item.id);
      if (aberto === item.id) setAberto(null);
      await carregar(1);
      atualizarContagens();
    } catch {
      setErro(tx("Não deu para apagar."));
    } finally {
      setOcupado(null);
    }
  }

  async function esvaziar() {
    setConfirmarEsvaziar(false);
    setOcupado("tudo");
    try {
      const { deleted } = await esvaziarSpam();
      setItens([]);
      setTotal(0);
      setAberto(null);
      setPagina(1);
      setAviso(`${plural(deleted, "mensagem apagada", "mensagens apagadas")}.`);
      atualizarContagens();
    } catch {
      setErro(tx("Não deu para esvaziar o Spam."));
    } finally {
      setOcupado(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={tx("Spam")}
        subtitle={tx(
          "Golpe e prospecção que a IA reconheceu, e o que chega de remetente bloqueado. Fica 30 dias e depois some sozinho.",
        )}
        action={
          total > 0 &&
          (confirmarEsvaziar ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">
                {total === 1
                  ? tx("Apagar a mensagem?")
                  : tx("Apagar as {0} mensagens?", total)}
              </span>
              <button
                type="button"
                className={botao}
                onClick={() => setConfirmarEsvaziar(false)}
              >
                {tx("Cancelar")}
              </button>
              <button
                type="button"
                onClick={esvaziar}
                className="inline-flex h-8 items-center rounded-[6px] bg-destructive px-2.5 text-xs font-medium text-white hover:bg-destructive/90"
              >
                {tx("Esvaziar")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={botao}
              disabled={ocupado !== null}
              onClick={() => setConfirmarEsvaziar(true)}
            >
              <Trash2 size={14} />
              {tx("Esvaziar spam")}
            </button>
          ))
        }
      />

      {aviso && (
        <p
          role="status"
          className="mb-4 rounded-[8px] bg-primary-soft px-4 py-2.5 text-sm text-primary-ink"
        >
          {aviso}
        </p>
      )}
      {erro && (
        <p
          role="alert"
          className="mb-4 rounded-[8px] bg-destructive-subtle px-4 py-2.5 text-sm text-destructive"
        >
          {erro}
        </p>
      )}

      <section
        aria-label={tx("Mensagens no Spam")}
        className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border"
      >
        {itens.length === 0 && !carregando ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <ShieldAlert size={20} className="text-text-tertiary" />
            <p className="text-sm font-medium text-text-primary">
              {tx("Spam vazio")}
            </p>
            <p className="max-w-sm text-xs text-text-tertiary">
              {tx(
                "Golpe e prospecção que chegarem caem aqui em vez da caixa. Bloquear um remetente também manda o que ele escrever para cá.",
              )}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border" data-testid="spam-list">
            {itens.map((item) => (
              <li key={item.id} data-testid="spam-row">
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
                  <button
                    type="button"
                    onClick={() => abrir(item.id)}
                    aria-expanded={aberto === item.id}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-text-primary">
                        {item.fromName || item.from}
                      </span>
                      {item.fromName && (
                        <span className="hidden truncate text-xs text-text-tertiary sm:inline">
                          {item.from}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-text-tertiary">
                        {quandoCurto(item.receivedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <Categoria c={item.category} />
                      <span className="truncate text-[13px] text-text-primary">
                        {item.subject || tx("(sem assunto)")}
                      </span>
                      {item.attachmentCount > 0 && (
                        <Paperclip
                          size={12}
                          className="shrink-0 text-text-tertiary"
                          aria-label={tx("Tem anexo")}
                        />
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-text-tertiary">
                      {tx("{0} · para {1}", motivo(item), item.recipient)}
                    </p>
                  </button>
                  <div className="flex gap-1.5 sm:shrink-0">
                    <button
                      type="button"
                      className={botao}
                      disabled={ocupado !== null}
                      onClick={() => devolver(item)}
                    >
                      <Undo2 size={14} />
                      {tx("Não é spam")}
                    </button>
                    <button
                      type="button"
                      aria-label={tx("Apagar a mensagem de {0}", item.from)}
                      className={cn(botao, "px-2 hover:text-destructive")}
                      disabled={ocupado !== null}
                      onClick={() => apagar(item)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {aberto === item.id && (
                  <div className="border-t border-border bg-bg-subtle/60 px-4 py-3">
                    {erroDetalhe ? (
                      <p role="alert">{tx("Não deu para abrir a mensagem.")}</p>
                    ) : !detalhe ? (
                      <div
                        className="h-24 rounded-[6px] bg-bg-muted/70"
                        aria-busy="true"
                      />
                    ) : (
                      <div className="grid gap-3">
                        {detalhe.bodyHtml ? (
                          <EmailHtmlFrame
                            html={detalhe.bodyHtml}
                            collapsedHeight={360}
                          />
                        ) : (
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-[13px] text-text-primary">
                            {detalhe.bodyText || tx("(sem texto)")}
                          </pre>
                        )}
                        {detalhe.attachments.length > 0 && (
                          <p className="text-xs text-text-tertiary">
                            {plural(
                              detalhe.attachments.length,
                              "anexo",
                              "anexos",
                            )}
                            :{" "}
                            {detalhe.attachments
                              .map((a) => `${a.filename} (${tamanho(a.size)})`)
                              .join(", ")}
                            {tx(
                              ". Ficam guardados e voltam junto se você tirar a mensagem do Spam.",
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {carregando && (
          <div className="grid gap-px" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[74px] bg-bg-muted/50" />
            ))}
          </div>
        )}
      </section>

      {!carregando && itens.length < total && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            className={botao}
            onClick={() => carregar(pagina + 1)}
          >
            {tx("Carregar mais")}
          </button>
        </div>
      )}
    </PageContainer>
  );
}
