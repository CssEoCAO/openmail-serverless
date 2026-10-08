import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { useRascunhos, notificarRascunhos } from "@/lib/rascunho";

/**
 * Lista dos rascunhos de resposta do usuário logado, em todas as caixas. Existe
 * para achar um rascunho sem lembrar em qual dos N contatos ele ficou: cada linha
 * leva pro `/m/:emailId` (MessageLinkPage), que já abre a caixa e a pessoa certas
 * e rola até a mensagem — lá o botão "Continuar rascunho" retoma o texto.
 */
export default function RascunhosPage() {
  const navigate = useNavigate();
  const { lista, carregando, erro } = useRascunhos();

  return (
    <PageContainer>
      <PageHeader
        title="Rascunhos"
        subtitle="Respostas que você começou e ainda não enviou, em todas as caixas. Clique para voltar à mensagem e continuar."
      />

      <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
        {erro ? (
          <p role="alert" className="px-4 py-6 text-sm text-destructive">
            Não foi possível carregar os rascunhos.{" "}
            <button
              type="button"
              className="underline"
              onClick={notificarRascunhos}
            >
              Tentar de novo
            </button>
          </p>
        ) : carregando && lista.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-tertiary">Carregando…</p>
        ) : lista.length === 0 ? (
          <p
            data-testid="rascunhos-vazio"
            className="px-4 py-6 text-sm text-text-tertiary"
          >
            Nenhum rascunho. Abra uma mensagem, clique em Responder e em “Salvar
            rascunho”.
          </p>
        ) : (
          <ul
            className="divide-y divide-border/60"
            data-testid="rascunhos-lista"
          >
            {lista.map((d) => {
              const quem = d.personName?.trim() || d.personEmail || d.emailId;
              const quando = new Date(d.updatedAt * 1000).toLocaleString([], {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              });
              const trecho = d.bodyText.replace(/\s+/g, " ").trim();
              return (
                <li key={d.emailId}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/m/${encodeURIComponent(d.emailId)}`)
                    }
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-muted/60"
                  >
                    <FileText
                      size={14}
                      className="mt-0.5 shrink-0 text-warning-text"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {quem}
                          {d.personName && d.personEmail && (
                            <span className="ml-1.5 font-light text-text-tertiary">
                              {d.personEmail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[11px] font-light text-text-tertiary">
                          {quando}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-secondary">
                        {d.subject?.trim() || "(sem assunto)"}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                        <span className="font-medium">
                          {d.fromAddress.split("@")[0]}
                        </span>
                        {" · "}
                        {trecho || "(sem texto)"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
