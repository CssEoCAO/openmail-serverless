import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Inbox, Layers, Send, AlertCircle } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { fetchStats, type Stats } from "@/lib/api";

/**
 * Tela inicial: escolha da caixa.
 *
 * Substitui o antigo "abre em todas as caixas com um dropdown de filtro". Com uma conta
 * que recebe por catch-all em dezenas de domínios, "todas juntas" é o caso raro, não o
 * padrão — e o dropdown escondia as caixas atrás de um clique que ninguém dava.
 *
 * "Ver todas juntas" fica no fim de propósito: continua sendo um clique, mas deixa de ser
 * o lugar onde a pessoa cai sem escolher.
 */

type Caixa = Stats["inboxes"][number];

/** Mesmo rótulo do dropdown antigo, pra caixa não trocar de nome ao mudar de tela. */
function rotulo(c: Caixa): string {
  return c.displayName || c.email.split("@")[0] || c.email;
}

function quando(epochSegundos: number | null): string {
  if (!epochSegundos) return "nada ainda";
  const dias = Math.floor((Date.now() / 1000 - epochSegundos) / 86400);
  if (dias <= 0) return "hoje";
  if (dias === 1) return "ontem";
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? "há 1 mês" : `há ${meses} meses`;
}

export default function SeletorCaixasPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [erro, setErro] = useState("");
  const [searchParams] = useSearchParams();

  // `/?q=` e `/?search=` sao deep links JA PUBLICADOS (link externo de admin, ver o
  // commit que os criou). A raiz deixou de ser a lista, entao eles cairiam numa tela
  // que ignora a busca. Redirecionar preserva os links que ja existem por aí — mudar
  // a URL documentada quebraria quem a guardou.
  const buscaDeepLink = searchParams.get("q") ?? searchParams.get("search");
  if (buscaDeepLink !== null) {
    return <Navigate to={`/inbox/todas?${searchParams.toString()}`} replace />;
  }

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() => setErro("Não consegui carregar as caixas"));
  }, []);

  const caixas = stats?.inboxes ?? [];
  // Não lidas primeiro, depois a que recebeu mais recente. Ordem alfabética faria a
  // caixa com 40 não lidas ficar embaixo de uma vazia só porque começa com "z".
  const ordenadas = [...caixas].sort(
    (a, b) => b.naoLidas - a.naoLidas || (b.ultima ?? 0) - (a.ultima ?? 0),
  );
  const totalNaoLidas = caixas.reduce((s, c) => s + c.naoLidas, 0);

  if (erro) {
    return (
      <PageContainer>
        <PageHeader title="Caixas" />
        <p className="text-sm text-text-secondary">{erro}</p>
      </PageContainer>
    );
  }

  if (stats && caixas.length === 0) {
    return (
      <PageContainer>
        <PageHeader title="Caixas" />
        <div className="rounded-[8px] bg-card px-5 py-8 text-center ring-1 ring-border">
          <p className="text-sm font-medium text-text-primary">
            Nenhuma caixa ainda
          </p>
          <p className="mt-1 text-xs font-light text-text-tertiary">
            Uma caixa aparece aqui na primeira mensagem que ela receber, ou
            quando alguém a cadastra em Inboxes.
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Caixas"
        subtitle={
          stats
            ? `${caixas.length} caixa${caixas.length === 1 ? "" : "s"}${
                totalNaoLidas > 0 ? ` · ${totalNaoLidas} não lidas` : ""
              }`
            : undefined
        }
      />

      <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
        <ul className="divide-y divide-border/60" data-testid="lista-caixas">
          {ordenadas.map((c) => (
            <li
              key={c.email}
              data-testid="caixa-row"
              data-inbox={c.email}
              className="group transition-colors hover:bg-text-primary/[0.02]"
            >
              <Link
                to={`/inbox/${encodeURIComponent(c.email)}`}
                className="flex items-center gap-3 px-5 py-3.5 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                  <Inbox size={14} className="text-text-tertiary" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {rotulo(c)}
                    </p>
                    {c.naoLidas > 0 && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-text-primary px-2 py-0.5 text-[10px] font-medium tabular-nums text-white">
                        {c.naoLidas}
                      </span>
                    )}
                    {/* Só recebe: dizer isso aqui evita a pessoa abrir a caixa,
                        escrever a resposta inteira e só então descobrir que este
                        endereço não tem remetente configurado. */}
                    {!c.podeEnviar && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-[10px] font-light text-text-tertiary"
                        title="Este endereço recebe, mas não está configurado para enviar"
                      >
                        <AlertCircle size={9} />
                        só recebe
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs font-light text-text-tertiary">
                    {c.email} · {c.total} mensage{c.total === 1 ? "m" : "ns"} ·{" "}
                    {quando(c.ultima)}
                  </p>
                </div>
                {c.podeEnviar && (
                  <Send
                    size={12}
                    className="shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-60"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <Link
        to="/inbox/todas"
        data-testid="ver-todas-juntas"
        className="mt-3 flex items-center justify-center gap-2 rounded-[8px] border border-border bg-card px-5 py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
      >
        <Layers size={14} />
        Ver todas juntas
      </Link>
    </PageContainer>
  );
}
