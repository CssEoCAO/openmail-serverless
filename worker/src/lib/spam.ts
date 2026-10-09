import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import type { schema } from "../db/schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { attachments } from "../db/attachments.schema";
import { blocklist } from "../db/blocklist.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { spamEmails, trustedSenders } from "../db/spam.schema";
import { domainOf, isBlocked } from "./blocklist";

type Database = DrizzleD1Database<typeof schema>;

/**
 * Spam automático: golpe e prospecção fria vão para `spam_emails` na chegada.
 *
 * A IA só julga quem a caixa não conhece. Medido em 196 e-mails reais de
 * 24/09–08/10/2026 (operacao/saasmail-frontend-20261008): o gpt-oss-120b chamou de
 * golpe o "Pagamento recusado" da Amazon e de prospecção a newsletter da Shopee,
 * porque não sabe que o remetente é quem diz ser nem que já escreveu 40 vezes.
 * Histórico com DMARC aprovado resolve os dois; golpe e prospecção quase sempre
 * chegam de endereço novo, e quem reincide cai no Spam sem gastar IA.
 */
export const MODELO_SPAM = "@cf/openai/gpt-oss-120b";
/** Golpe custa mais deixar passar; prospecção errada some newsletter. */
export const LIMIAR_SPAM = { golpe: 0.85, prospeccao: 0.9 } as const;
export const DIAS_NO_SPAM = 30;
const ESPERA_IA_MS = 20_000;

export type CategoriaSpam = "golpe" | "prospeccao" | "bloqueio" | "reincidente";

export type DecisaoSpam =
  | { spam: false; porque: string }
  | {
      spam: true;
      category: CategoriaSpam;
      reason: string;
      confidence: number | null;
    };

export interface EmailParaJulgar {
  from: string;
  fromName: string | null;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  dmarc: string | null;
  spf: string | null;
  listUnsubscribe: boolean;
  anexos: string[];
}

/**
 * Quem é a empresa e quem escreve para ela de verdade: as duas primeiras linhas
 * do prompt. Cada instalação descreve a sua em SPAM_AI_CONTEXT (wrangler.jsonc).
 */
export const CONTEXTO_SPAM_PADRAO =
  "Você classifica e-mails que chegam nas caixas de uma pequena empresa.\nQuem escreve de verdade: clientes (suporte, cobrança, reembolso, nota fiscal, acesso, dúvidas), parceiros, fornecedores, órgãos públicos, plataformas e serviços que a empresa usa, e as newsletters e notificações desses serviços.";

export function sistemaSpam(contexto = CONTEXTO_SPAM_PADRAO): string {
  return `${contexto.trim()}

Responda SOMENTE um JSON, sem texto fora dele:
{"categoria":"golpe"|"prospeccao"|"legitimo","confianca":0.0-1.0,"motivo":"até 12 palavras em português"}

golpe: tenta enganar. Phishing; falso aviso de conta limitada, suspensa, disputa ou pagamento; cobrança ou "última chance" de domínio, e-mail ou hospedagem vinda de quem não é o registrador; prêmio, herança, investimento; falsa verificação (Meta Verified e afins); anexo ou link para "ver fotos/danos/documento"; remetente que se passa por banco ou marca usando domínio que não é dela; conversa de negócio inventada ("Re: Re:" sem histórico real); conta de universidade, escola ou governo estrangeiro falando de assunto sem relação com ela (conta invadida), mesmo que o texto pareça de cliente; oferta para registrar, renovar ou comprar domínio parecido com o da empresa (outra extensão, como .net) vinda de quem não é o registrador (no Brasil, o oficial é registro.br).
prospeccao: oferta comercial não pedida e genérica, mandada em massa: SEO, desenvolvimento, design, marketing ou "growth", telefonia e internet corporativa, listas de contatos, venda de domínio, catálogo de fornecedor, parceria genérica que não mostra conhecer o produto.
legitimo: todo o resto. Inclusive:
- boas-vindas, confirmação de cadastro, código de verificação, link de acesso, fim de período de teste: a empresa se cadastra em muitas ferramentas;
- newsletter ou aviso de empresa estabelecida (marketplace, logística, pagamentos, banco, programa de afiliados, ferramenta de software), mesmo promovendo produto;
- propostas que citam com detalhe um produto específico da empresa;
- qualquer pessoa pedindo ajuda.
prospeccao é alguém tentando VENDER um serviço à empresa sem relação anterior, em geral agência, freelancer ou revendedor, com texto genérico.

DMARC=pass prova que o e-mail saiu mesmo do domínio do remetente: se o domínio é o da própria marca (amazon.com.br, shopee.com.br, loggi.com), não é falsificação.
Na dúvida, legitimo. Cliente que reclama, pede reembolso ou escreve mal NÃO é golpe. Domínio gratuito (gmail, hotmail, outlook) sozinho não é sinal de nada.`;
}

/** Texto corrido do corpo (o HTML perde as tags), cortado no que a IA precisa ler. */
export function textoDoCorpo(
  texto: string | null,
  html: string | null,
): string {
  let t = texto?.trim() || "";
  if (!t && html) {
    t = html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  }
  return t
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, 1500);
}

export function mensagemParaIA(e: EmailParaJulgar): string {
  return [
    `De: ${e.fromName ? `${e.fromName} ` : ""}<${e.from}>`,
    `Para: ${e.to}`,
    `Assunto: ${e.subject || "(sem assunto)"}`,
    `Autenticação: DMARC=${e.dmarc ?? "?"} SPF=${e.spf ?? "?"}`,
    `Lista de e-mail (List-Unsubscribe): ${e.listUnsubscribe ? "sim" : "não"}`,
    `Anexos: ${e.anexos.length ? e.anexos.join(", ") : "nenhum"}`,
    "",
    "Corpo (início):",
    textoDoCorpo(e.text, e.html) || "(vazio)",
  ].join("\n");
}

export interface VereditoIA {
  categoria: "golpe" | "prospeccao" | "legitimo";
  confianca: number;
  motivo: string;
}

/** Primeiro objeto JSON da resposta; null se a IA não respondeu no formato. */
export function lerVeredito(texto: unknown): VereditoIA | null {
  const m = String(texto ?? "").match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const categoria = j.categoria;
    const confianca = Number(j.confianca);
    if (
      (categoria !== "golpe" &&
        categoria !== "prospeccao" &&
        categoria !== "legitimo") ||
      !["number", "string"].includes(typeof j.confianca) ||
      String(j.confianca).trim() === "" ||
      !Number.isFinite(confianca) ||
      confianca < 0 ||
      confianca > 1
    ) {
      return null;
    }
    return {
      categoria,
      confianca,
      motivo: String(j.motivo ?? "").slice(0, 120),
    };
  } catch {
    return null;
  }
}

/** O binding devolve formatos diferentes conforme o modelo; o texto pode vir em três lugares. */
export function textoDaResposta(r: unknown): string {
  const res = r as {
    response?: unknown;
    choices?: Array<{ message?: { content?: string | null } }>;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  } | null;
  if (typeof res?.response === "string") return res.response;
  if (res?.response && typeof res.response === "object")
    return JSON.stringify(res.response);
  const c = res?.choices?.[0]?.message?.content;
  if (c) return c;
  for (const o of res?.output ?? []) {
    for (const p of o?.content ?? []) if (p?.text) return p.text;
  }
  return "";
}

export function vereditoEhSpam(v: VereditoIA): boolean {
  return v.categoria !== "legitimo" && v.confianca >= LIMIAR_SPAM[v.categoria];
}

/** Erro e demora da IA viram null e o e-mail entra: errar pra dentro da caixa. */
export async function classificarComIA(
  ai: Ai,
  e: EmailParaJulgar,
  contexto?: string,
): Promise<VereditoIA | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resposta = await Promise.race([
      ai.run(
        MODELO_SPAM as never,
        {
          messages: [
            { role: "system", content: sistemaSpam(contexto || undefined) },
            { role: "user", content: mensagemParaIA(e) },
          ],
          // O raciocínio do modelo come tokens antes da resposta: com 400 metade
          // das chamadas voltava cortada, sem JSON.
          max_tokens: 1500,
          temperature: 0,
          reasoning: { effort: "low" },
        } as never,
      ),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`sem resposta em ${ESPERA_IA_MS} ms`)),
          ESPERA_IA_MS,
        );
      }),
    ]);
    const veredito = lerVeredito(textoDaResposta(resposta));
    if (!veredito) {
      console.error(
        "[spam] IA respondeu fora do formato; e-mail entra na caixa",
      );
    }
    return veredito;
  } catch (err) {
    console.error("[spam] IA falhou, e-mail entra na caixa:", err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decide na chegada, nesta ordem: confiável passa; bloqueado vai pro Spam; quem a
 * caixa conhece e chega autenticado passa; quem já foi pro Spam volta pra lá; o
 * resto a IA julga. Remetente com histórico mas sem DMARC aprovado vai pra IA:
 * o golpe "conta limitada" chegou com From falsificado de uma caixa nossa.
 */
export async function decidirSpam(
  db: Database,
  ai: Ai | undefined,
  e: EmailParaJulgar,
  contexto?: string,
): Promise<DecisaoSpam> {
  const from = e.from.trim().toLowerCase();

  const confiavel = await db
    .select({ email: trustedSenders.email })
    .from(trustedSenders)
    .where(
      and(
        eq(trustedSenders.email, from),
        or(
          eq(trustedSenders.recipient, "*"),
          eq(trustedSenders.recipient, e.to.toLowerCase()),
        ),
      ),
    )
    .limit(1);
  if (confiavel.length > 0 && e.dmarc === "pass")
    return { spam: false, porque: "confiável" };

  if (await isBlocked(db, from)) {
    return {
      spam: true,
      category: "bloqueio",
      reason: "Remetente bloqueado",
      confidence: null,
    };
  }

  if (e.dmarc === "pass") {
    const dominio = domainOf(from);
    const nosso = await db
      .select({ email: senderIdentities.email })
      .from(senderIdentities)
      .where(sql`lower(${senderIdentities.email}) LIKE ${"%@" + dominio}`)
      .limit(1);
    if (nosso.length > 0) return { spam: false, porque: "domínio nosso" };

    const pessoa = await db
      .select({ id: people.id, total: people.totalCount })
      .from(people)
      .where(eq(people.email, from))
      .limit(1);
    if (pessoa.length > 0) {
      if (pessoa[0].total > 0) return { spam: false, porque: "histórico" };
      const respondida = await db
        .select({ id: sentEmails.id })
        .from(sentEmails)
        .where(eq(sentEmails.personId, pessoa[0].id))
        .limit(1);
      if (respondida.length > 0)
        return { spam: false, porque: "já recebeu e-mail nosso" };
    }
  }

  const anterior = await db
    .select({ category: spamEmails.category })
    .from(spamEmails)
    .where(eq(spamEmails.fromAddress, from))
    .orderBy(desc(spamEmails.receivedAt))
    .limit(1);
  if (anterior.length > 0) {
    return {
      spam: true,
      category: "reincidente",
      reason: "Remetente já foi para o Spam",
      confidence: null,
    };
  }

  if (!ai) return { spam: false, porque: "sem IA" };
  const v = await classificarComIA(ai, e, contexto);
  if (!v) return { spam: false, porque: "IA sem veredito" };
  if (!vereditoEhSpam(v)) {
    return {
      spam: false,
      porque: `IA: ${v.categoria} ${v.confianca.toFixed(2)}`,
    };
  }
  return {
    spam: true,
    category: v.categoria as "golpe" | "prospeccao",
    reason: v.motivo,
    confidence: v.confianca,
  };
}

export interface AnexoSpam {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  contentId: string | null;
}

function lerAnexos(json: string | null): AnexoSpam[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? (a as AnexoSpam[]) : [];
  } catch {
    return [];
  }
}

/**
 * "Não é spam": devolve à caixa TODO o spam desse remetente que o usuário pode
 * ver, com os mesmos ids (os anexos no R2 continuam onde estavam). Com `global`
 * (admin: bloqueio é coisa de admin), confia globalmente no remetente e tira a
 * regra de bloqueio do endereço; regra de domínio fica, e a confiança vale por
 * cima dela só para esse endereço.
 */
export async function restaurarRemetente(
  db: Database,
  fromAddress: string,
  podeVer: (recipient: string) => boolean,
  { global }: { global: boolean },
): Promise<number> {
  const from = fromAddress.trim().toLowerCase();
  const linhas = (
    await db.select().from(spamEmails).where(eq(spamEmails.fromAddress, from))
  ).filter((s) => podeVer(s.recipient));
  const now = Math.floor(Date.now() / 1000);
  if (linhas.length === 0) return 0;

  const ultima = Math.max(...linhas.map((s) => s.receivedAt));
  await db
    .insert(people)
    .values({
      id: nanoid(),
      email: from,
      name: linhas[0].fromName,
      lastEmailAt: ultima,
      unreadCount: 0,
      totalCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: people.email });
  const pessoa = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, from))
    .limit(1);
  const personId = pessoa[0]!.id;

  let devolvidos = 0;
  for (const s of linhas) {
    // Mesma mensagem já na caixa (entrega repetida): só sai do Spam.
    const jaNaCaixa = s.messageId
      ? await db
          .select({ id: emails.id })
          .from(emails)
          .where(
            and(
              eq(emails.messageId, s.messageId),
              eq(emails.recipient, s.recipient),
            ),
          )
          .limit(1)
      : [];
    const ops: unknown[] = [];
    if (jaNaCaixa.length === 0) {
      ops.push(
        // O lote só restaura se a linha ainda existe; expurgo concorrente não ressuscita anexos apagados.
        db
          .insert(emails)
          .select(
            db
              .select({
                id: spamEmails.id,
                personId: sql<string>`${personId}`.as("person_id"),
                recipient: spamEmails.recipient,
                subject: spamEmails.subject,
                bodyHtml: spamEmails.bodyHtml,
                bodyText: spamEmails.bodyText,
                rawHeaders: spamEmails.rawHeaders,
                messageId: spamEmails.messageId,
                spf: spamEmails.spf,
                dkim: spamEmails.dkim,
                dmarc: spamEmails.dmarc,
                spamScore: sql<number | null>`NULL`.as("spam_score"),
                isRead: sql<number>`0`.as("is_read"),
                cc: spamEmails.cc,
                conversationId: spamEmails.conversationId,
                gmailMessageId: sql<string | null>`NULL`.as("gmail_message_id"),
                gmailThreadId: sql<string | null>`NULL`.as("gmail_thread_id"),
                receivedAt: spamEmails.receivedAt,
                createdAt: sql<number>`${now}`.as("created_at"),
              })
              .from(spamEmails)
              .where(eq(spamEmails.id, s.id)),
          )
          .onConflictDoNothing()
          .returning({ id: emails.id }),
        ...lerAnexos(s.attachments).map((a) =>
          db
            .insert(attachments)
            .select(
              db
                .select({
                  id: sql<string>`${a.id}`.as("id"),
                  emailId: spamEmails.id,
                  kind: sql<string>`'inbound'`.as("kind"),
                  filename: sql<string>`${a.filename}`.as("filename"),
                  contentType: sql<string>`${a.contentType}`.as("content_type"),
                  size: sql<number>`${a.size}`.as("size"),
                  r2Key: sql<string>`${a.r2Key}`.as("r2_key"),
                  contentId: sql<string | null>`${a.contentId}`.as(
                    "content_id",
                  ),
                  createdAt: sql<number>`${now}`.as("created_at"),
                })
                .from(spamEmails)
                .where(
                  and(
                    eq(spamEmails.id, s.id),
                    sql`EXISTS (SELECT 1 FROM emails WHERE id = ${s.id})`,
                  ),
                ),
            )
            .onConflictDoNothing(),
        ),
        db
          .update(people)
          .set({
            lastEmailAt: sql`MAX(${people.lastEmailAt}, ${s.receivedAt})`,
            unreadCount: sql`(SELECT count(*) FROM emails WHERE person_id = ${personId} AND is_read = 0)`,
            totalCount: sql`(SELECT count(*) FROM emails WHERE person_id = ${personId})`,
            updatedAt: now,
          })
          .where(eq(people.id, personId)),
      );
    }
    ops.push(db.delete(spamEmails).where(eq(spamEmails.id, s.id)));
    const resultado = await db.batch(ops as never);
    if (jaNaCaixa.length === 0)
      devolvidos += (resultado[0] as unknown[]).length;
  }
  for (const recipient of global
    ? ["*"]
    : new Set(linhas.map((s) => s.recipient))) {
    await db
      .insert(trustedSenders)
      .values({ email: from, recipient, createdAt: now })
      .onConflictDoNothing();
  }
  if (global) {
    await db
      .delete(blocklist)
      .where(and(eq(blocklist.type, "email"), eq(blocklist.value, from)));
  }
  return devolvidos;
}

/** Apaga de vez: as linhas e os anexos delas no R2. */
export async function apagarSpam(
  db: Database,
  r2: R2Bucket,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  let apagados = 0;
  // D1 aceita até 100 parâmetros por consulta.
  for (let i = 0; i < ids.length; i += 90) {
    const lote = ids.slice(i, i + 90);
    // Só apaga objetos das linhas que esta operação ganhou; restauração pode ter vencido.
    const linhas = await db
      .delete(spamEmails)
      .where(inArray(spamEmails.id, lote))
      .returning({ id: spamEmails.id, attachments: spamEmails.attachments });
    const chaves = linhas.flatMap((l) =>
      lerAnexos(l.attachments).map((a) => a.r2Key),
    );
    if (chaves.length > 0) await r2.delete(chaves);
    apagados += linhas.length;
  }
  return apagados;
}

/** Cron de hora em hora: o que passou de 30 dias no Spam vai embora. */
export async function expurgarSpamAntigo(
  db: Database,
  r2: R2Bucket,
  agoraS = Math.floor(Date.now() / 1000),
): Promise<number> {
  const corte = agoraS - DIAS_NO_SPAM * 86_400;
  const velhos = await db
    .select({ id: spamEmails.id })
    .from(spamEmails)
    .where(lt(spamEmails.receivedAt, corte))
    .limit(500);
  return apagarSpam(
    db,
    r2,
    velhos.map((v) => v.id),
  );
}
