/**
 * Árvore de caixas da lateral: domínio → caixas.
 *
 * Com catch-all em dezenas de domínios, a maioria das caixas recebe uma newsletter
 * por mês e nada mais. Ficam à vista as que têm o que fazer (não lidas), as que
 * enviam (identidade configurada) e as que receberam nos últimos 7 dias; o resto vai
 * para "sem movimento", recolhido dentro do domínio. Quem tem novidade sobe: caixa e
 * domínio se ordenam por não lidas, depois pela mensagem mais recente.
 *
 * Sem dependência nenhuma, para o teste do Worker importar direto
 * (worker/src/__tests__/arvore-caixas.test.ts).
 */

export interface CaixaResumo {
  email: string;
  displayName: string | null;
  podeEnviar: boolean;
  total: number;
  naoLidas: number;
  /** Epoch em segundos da mensagem mais recente; null se nunca recebeu. */
  ultima: number | null;
}

export interface NoDominio {
  dominio: string;
  naoLidas: number;
  ultima: number;
  ativas: CaixaResumo[];
  paradas: CaixaResumo[];
}

const JANELA_ATIVA_S = 7 * 86_400;

export function dominioDe(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? email : email.slice(at + 1).toLowerCase();
}

export function rotuloCaixa(c: Pick<CaixaResumo, "email" | "displayName">) {
  return c.displayName?.trim() || c.email.split("@")[0] || c.email;
}

function porNovidade(
  a: { naoLidas: number; ultima: number | null },
  b: { naoLidas: number; ultima: number | null },
): number {
  return b.naoLidas - a.naoLidas || (b.ultima ?? 0) - (a.ultima ?? 0);
}

/**
 * Monta a árvore. Com `filtro`, mostra toda caixa cujo endereço ou nome contém o
 * texto (sem separar ativas de paradas: quem filtra está procurando uma específica).
 */
export function montarArvore(
  caixas: CaixaResumo[],
  agoraS: number,
  filtro = "",
): NoDominio[] {
  const f = filtro.trim().toLowerCase();
  const grupos = new Map<string, CaixaResumo[]>();
  for (const c of caixas) {
    if (
      f &&
      !c.email.toLowerCase().includes(f) &&
      !(c.displayName ?? "").toLowerCase().includes(f)
    )
      continue;
    const d = dominioDe(c.email);
    const lista = grupos.get(d);
    if (lista) lista.push(c);
    else grupos.set(d, [c]);
  }

  const nos: NoDominio[] = [];
  for (const [dominio, lista] of grupos) {
    lista.sort((a, b) => porNovidade(a, b) || a.email.localeCompare(b.email));
    const ativa = (c: CaixaResumo) =>
      !!f ||
      c.naoLidas > 0 ||
      c.podeEnviar ||
      (c.ultima !== null && agoraS - c.ultima < JANELA_ATIVA_S);
    nos.push({
      dominio,
      naoLidas: lista.reduce((s, c) => s + c.naoLidas, 0),
      ultima: lista.reduce((m, c) => Math.max(m, c.ultima ?? 0), 0),
      ativas: lista.filter(ativa),
      paradas: lista.filter((c) => !ativa(c)),
    });
  }
  return nos.sort(
    (a, b) => porNovidade(a, b) || a.dominio.localeCompare(b.dominio),
  );
}
