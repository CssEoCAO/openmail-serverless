/**
 * Rascunhos de resposta.
 *
 * O **servidor** (`/api/drafts`, um por usuário e mensagem) é a verdade: é o que
 * sobrevive a trocar de aparelho e o que a caixa marca com "Rascunho". Quem grava
 * lá é o botão "Salvar rascunho" do ReplyComposer — sem autosave remoto, uma
 * gravação por vez. Quem apaga é o composer, e SÓ depois que o envio confirmou.
 *
 * O **localStorage** (este módulo) é só backup do que ainda não foi salvo no
 * servidor, para o texto não sumir se a aba fechar. Chave por **usuário e
 * mensagem** (`saasmail.rascunho.<userId>.<emailId>`): dois logins no mesmo
 * navegador nunca veem o backup um do outro. A chave antiga sem usuário
 * (`saasmail.rascunho.<emailId>`) não tem dono conhecido e é descartada, nunca
 * atribuída a quem estiver logado.
 *
 * O que NÃO se guarda em nenhuma das duas: anexos. `File` não serializa, e o
 * composer diz isso em voz alta em vez de deixar o usuário supor que o PDF
 * voltou junto com o texto.
 */

import { useEffect, useState } from "react";
import { fetchDrafts, type ReplyDraft } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

const PREFIXO = "saasmail.rascunho.";
/** Backups older than this are dropped on read. A reply you abandoned a month ago
 *  reappearing under a new message is worse than losing it. */
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

export interface Rascunho {
  fromAddress: string;
  cc: unknown[];
  bodyHtml: string;
  bodyText: string;
  /** epoch ms, used for expiry */
  em: number;
}

const chave = (userId: string, emailId: string) =>
  `${PREFIXO}${userId}.${emailId}`;
const chaveLegada = (emailId: string) => `${PREFIXO}${emailId}`;

/** True when there is nothing worth keeping — avoids writing a row per opened reply. */
export function rascunhoVazio(r: Omit<Rascunho, "em">): boolean {
  const texto = (r.bodyText || "").replace(/\s| /g, "");
  return texto === "" && (r.cc?.length ?? 0) === 0;
}

export function lerRascunho(userId: string, emailId: string): Rascunho | null {
  try {
    // Backup sem dono: some. Foi gravado antes do escopo por usuário e não dá
    // para saber de quem é.
    window.localStorage?.removeItem(chaveLegada(emailId));
    const cru = window.localStorage?.getItem(chave(userId, emailId));
    if (!cru) return null;
    const r = JSON.parse(cru) as Rascunho;
    if (typeof r?.bodyHtml !== "string" || typeof r?.em !== "number")
      return null;
    if (Date.now() - r.em > VALIDADE_MS) {
      apagarRascunho(userId, emailId);
      return null;
    }
    return r;
  } catch {
    // Corrupted JSON, private mode, disabled storage. A backup is a convenience —
    // it must never be the reason the composer fails to open.
    return null;
  }
}

export function salvarRascunho(
  userId: string,
  emailId: string,
  r: Omit<Rascunho, "em">,
): void {
  try {
    if (rascunhoVazio(r)) {
      apagarRascunho(userId, emailId);
      return;
    }
    window.localStorage?.setItem(
      chave(userId, emailId),
      JSON.stringify({ ...r, em: Date.now() }),
    );
  } catch {
    // Quota exceeded is the realistic failure here. Losing the backup silently is bad,
    // but throwing inside an onChange handler would break typing itself.
  }
}

export function apagarRascunho(userId: string, emailId: string): void {
  try {
    window.localStorage?.removeItem(chave(userId, emailId));
  } catch {
    /* nothing to do */
  }
}

// --- rascunhos do servidor, compartilhados pela tela ------------------------
// Um cache por aba E por usuário: a lista é do usuário logado e é pequena. Quem
// muda um rascunho (o composer) chama `notificarRascunhos()`, e toda bolha ou
// linha da caixa que usa o hook refaz a leitura — mesmo desenho do
// HIDE_SIGNATURES_EVENT. Trocar de usuário na mesma aba invalida o cache.

export const RASCUNHOS_EVENT = "saasmail:rascunhos-changed";

let cache: { userId: string; lista: ReplyDraft[] } | null = null;
let emVoo: { userId: string; p: Promise<ReplyDraft[]> } | null = null;

function carregar(userId: string, force = false): Promise<ReplyDraft[]> {
  if (cache && cache.userId === userId && !force)
    return Promise.resolve(cache.lista);
  if (emVoo && emVoo.userId === userId) return emVoo.p;
  const p = fetchDrafts()
    .then((lista) => {
      cache = { userId, lista };
      return lista;
    })
    .finally(() => {
      if (emVoo?.p === p) emVoo = null;
    });
  emVoo = { userId, p };
  return p;
}

/** Chamar depois de gravar ou apagar um rascunho no servidor. */
export function notificarRascunhos(): void {
  cache = null;
  window.dispatchEvent(new CustomEvent(RASCUNHOS_EVENT));
}

/**
 * Rascunhos do usuário logado no servidor, indexados por mensagem e por pessoa,
 * mais a lista crua para a página /rascunhos. Vazio até a sessão e a lista
 * chegarem; reage ao RASCUNHOS_EVENT.
 */
export function useRascunhos(): {
  lista: ReplyDraft[];
  porEmail: Set<string>;
  porPessoa: Set<string>;
  carregando: boolean;
  erro: boolean;
} {
  const { data: sessao } = useSession();
  const userId: string | null = sessao?.user?.id ?? null;
  const [estado, setEstado] = useState<{
    userId: string;
    lista: ReplyDraft[];
    erro?: boolean;
  } | null>(() => cache);
  useEffect(() => {
    if (!userId) return;
    let vivo = true;
    const aplicar = (lista: ReplyDraft[]) =>
      vivo && setEstado({ userId, lista });
    const falhou = () => vivo && setEstado({ userId, lista: [], erro: true });
    const refresh = () => {
      carregar(userId, true).then(aplicar).catch(falhou);
    };
    carregar(userId).then(aplicar).catch(falhou);
    window.addEventListener(RASCUNHOS_EVENT, refresh);
    return () => {
      vivo = false;
      window.removeEventListener(RASCUNHOS_EVENT, refresh);
    };
  }, [userId]);
  // Estado de outro usuário (login trocado na mesma aba) não vale nada.
  const lista = estado && estado.userId === userId ? estado.lista : [];
  return {
    lista,
    porEmail: new Set(lista.map((d) => d.emailId)),
    porPessoa: new Set(lista.flatMap((d) => (d.personId ? [d.personId] : []))),
    carregando: !userId || estado?.userId !== userId,
    erro: estado?.userId === userId && !!estado.erro,
  };
}

/** O rascunho de resposta é o rascunho com contextKey `reply:<emailId>` — uma tabela, um router. */
export const replyKey = (emailId: string) => `reply:${emailId}`;
