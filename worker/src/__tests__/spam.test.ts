import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { handleEmail, ingestParsedEmail } from "../email-handler";
import { parseEmail } from "../lib/email-parser";
import { emails } from "../db/emails.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { blocklist } from "../db/blocklist.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { spamEmails, trustedSenders } from "../db/spam.schema";
import {
  CONTEXTO_SPAM_PADRAO,
  decidirSpam,
  sistemaSpam,
  apagarSpam,
  restaurarRemetente,
  expurgarSpamAntigo,
  lerVeredito,
  textoDaResposta,
  textoDoCorpo,
  vereditoEhSpam,
  type EmailParaJulgar,
} from "../lib/spam";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const agora = () => Math.floor(Date.now() / 1000);

function iaQueResponde(texto: string) {
  return { run: vi.fn(async () => ({ response: texto })) } as unknown as Ai & {
    run: ReturnType<typeof vi.fn>;
  };
}

function iaQueNaoPodeSerChamada() {
  return {
    run: vi.fn(async () => {
      throw new Error("a IA não devia ser chamada");
    }),
  } as unknown as Ai & { run: ReturnType<typeof vi.fn> };
}

function email(over: Partial<EmailParaJulgar> = {}): EmailParaJulgar {
  return {
    from: "novo@desconhecido.test",
    fromName: null,
    to: "support@example.com",
    subject: "Oi",
    text: "Texto",
    html: null,
    dmarc: "pass",
    spf: "pass",
    listUnsubscribe: false,
    anexos: [],
    ...over,
  };
}

async function spamRow(over: Partial<typeof spamEmails.$inferInsert> = {}) {
  const row = {
    id: over.id ?? `spam-${Math.random().toString(36).slice(2)}`,
    recipient: "support@example.com",
    fromAddress: "golpista@fraude.test",
    fromName: "Golpista",
    subject: "Sua conta foi limitada",
    bodyText: "Clique aqui",
    bodyHtml: null,
    messageId: `<${Math.random()}@fraude.test>`,
    category: "golpe",
    reason: "phishing",
    confidence: 0.95,
    receivedAt: agora(),
    createdAt: agora(),
    ...over,
  };
  await getDb().insert(spamEmails).values(row);
  return row;
}

function inboundMessage(raw: string, to = "support@example.com") {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "sender@example.com",
    to,
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as any;
}

function ctx() {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as any;
}

function rawEmail(from: string, messageId: string, subject = "Assunto") {
  return [
    `From: Remetente <${from}>`,
    "To: support@example.com",
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Olá",
  ].join("\r\n");
}

/** O env real com um binding de IA falso por cima. */
function envCom(ai: Ai) {
  return new Proxy(env as object, {
    get: (t, k) => (k === "AI" ? ai : Reflect.get(t, k)),
  }) as unknown as CloudflareBindings;
}

describe("leitura da resposta da IA", () => {
  it("acha o JSON no meio do texto e recusa confiança fora da escala", () => {
    expect(
      lerVeredito(
        'Veredito: {"categoria":"prospeccao","confianca":"0.95","motivo":"oferta de SEO"} fim',
      ),
    ).toEqual({
      categoria: "prospeccao",
      confianca: 0.95,
      motivo: "oferta de SEO",
    });
    expect(
      lerVeredito('{"categoria":"golpe","confianca":3,"motivo":"x"}'),
    ).toBeNull();
    expect(lerVeredito('{"categoria":"golpe","confianca":true}')).toBeNull();
  });

  it("recusa categoria desconhecida e resposta sem JSON", () => {
    expect(lerVeredito('{"categoria":"spam","confianca":1}')).toBeNull();
    expect(lerVeredito("não sei")).toBeNull();
    expect(lerVeredito(undefined)).toBeNull();
  });

  it("acha o texto nos três formatos do binding", () => {
    expect(textoDaResposta({ response: "a" })).toBe("a");
    expect(textoDaResposta({ choices: [{ message: { content: "b" } }] })).toBe(
      "b",
    );
    expect(textoDaResposta({ output: [{ content: [{ text: "c" }] }] })).toBe(
      "c",
    );
    expect(textoDaResposta(null)).toBe("");
  });

  it("golpe a partir de 0,85; prospecção a partir de 0,90; legítimo nunca", () => {
    const v = (categoria: "golpe" | "prospeccao" | "legitimo", c: number) =>
      vereditoEhSpam({ categoria, confianca: c, motivo: "" });
    expect(v("golpe", 0.85)).toBe(true);
    expect(v("golpe", 0.84)).toBe(false);
    expect(v("prospeccao", 0.9)).toBe(true);
    expect(v("prospeccao", 0.89)).toBe(false);
    expect(v("legitimo", 1)).toBe(false);
  });

  it("tira tags, estilo e entidades do HTML", () => {
    expect(
      textoDoCorpo(
        null,
        "<style>p{color:red}</style><p>Conta&nbsp;limitada &amp; bloqueada</p><br>Clique",
      ),
    ).toBe("Conta limitada & bloqueada\nClique");
  });
});

describe("decidirSpam", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("o contexto da instalação abre o prompt; sem ele, o genérico", async () => {
    const ia = iaQueResponde(
      '{"categoria":"legitimo","confianca":0.9,"motivo":"x"}',
    );
    const sistema = async (contexto?: string) => {
      ia.run.mockClear();
      await decidirSpam(getDb(), ia, email(), contexto);
      return ia.run.mock.calls[0][1].messages[0].content as string;
    };
    expect(await sistema("Empresa X.\nQuem escreve: Y.")).toMatch(
      /^Empresa X\.\nQuem escreve: Y\.\n\nResponda SOMENTE um JSON/,
    );
    expect(await sistema()).toBe(sistemaSpam(CONTEXTO_SPAM_PADRAO));
    expect(await sistema("")).toBe(sistemaSpam(CONTEXTO_SPAM_PADRAO));
  });

  it("remetente confiável passa sem IA", async () => {
    await getDb()
      .insert(trustedSenders)
      .values({ email: "novo@desconhecido.test", createdAt: agora() });
    const ia = iaQueNaoPodeSerChamada();
    expect(await decidirSpam(getDb(), ia, email())).toEqual({
      spam: false,
      porque: "confiável",
    });
    expect(ia.run).not.toHaveBeenCalled();
  });

  it("bloqueado vai pro Spam sem IA, inclusive por domínio", async () => {
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "domain",
      value: "desconhecido.test",
      createdAt: agora(),
    });
    const ia = iaQueNaoPodeSerChamada();
    const d = await decidirSpam(getDb(), ia, email());
    expect(d).toMatchObject({ spam: true, category: "bloqueio" });
    expect(ia.run).not.toHaveBeenCalled();
  });

  it("From confiável sem autenticação alinhada não pula a IA", async () => {
    await getDb()
      .insert(trustedSenders)
      .values({ email: "novo@desconhecido.test", createdAt: agora() });
    const ia = iaQueResponde(
      '{"categoria":"golpe","confianca":0.99,"motivo":"From falsificado"}',
    );
    expect(
      (await decidirSpam(getDb(), ia, email({ dmarc: "fail" }))).spam,
    ).toBe(true);
    expect(ia.run).toHaveBeenCalledOnce();
  });

  it("quem já escreveu e chega autenticado passa sem IA", async () => {
    await createTestPerson({
      id: "p1",
      email: "novo@desconhecido.test",
      totalCount: 3,
    });
    const ia = iaQueNaoPodeSerChamada();
    expect(await decidirSpam(getDb(), ia, email())).toEqual({
      spam: false,
      porque: "histórico",
    });
  });

  it("histórico sem DMARC aprovado ainda passa pela IA (From falsificado)", async () => {
    await createTestPerson({
      id: "p1",
      email: "novo@desconhecido.test",
      totalCount: 3,
    });
    const ia = iaQueResponde(
      '{"categoria":"golpe","confianca":0.95,"motivo":"conta limitada falsa"}',
    );
    const d = await decidirSpam(getDb(), ia, email({ dmarc: "fail" }));
    expect(ia.run).toHaveBeenCalledOnce();
    expect(d).toMatchObject({
      spam: true,
      category: "golpe",
      confidence: 0.95,
    });
  });

  it("quem já foi pro Spam volta pra lá sem IA", async () => {
    await spamRow({ fromAddress: "novo@desconhecido.test" });
    const ia = iaQueNaoPodeSerChamada();
    const d = await decidirSpam(getDb(), ia, email());
    expect(d).toMatchObject({ spam: true, category: "reincidente" });
  });

  it("prospecção abaixo de 0,90 entra na caixa", async () => {
    const ia = iaQueResponde(
      '{"categoria":"prospeccao","confianca":0.85,"motivo":"newsletter"}',
    );
    expect((await decidirSpam(getDb(), ia, email())).spam).toBe(false);
  });

  it("IA com erro, fora do formato ou ausente: entra na caixa", async () => {
    const quebrada = {
      run: vi.fn(async () => {
        throw new Error("5028");
      }),
    } as unknown as Ai;
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await decidirSpam(getDb(), quebrada, email())).toEqual({
      spam: false,
      porque: "IA sem veredito",
    });
    expect(
      (await decidirSpam(getDb(), iaQueResponde("não sei dizer"), email()))
        .spam,
    ).toBe(false);
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
    expect(await decidirSpam(getDb(), undefined, email())).toEqual({
      spam: false,
      porque: "sem IA",
    });
  });
});

describe("chegada de e-mail com spam", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("bloqueado vai pro Spam em vez de sumir, uma vez só por Message-ID", async () => {
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "email",
      value: "chato@marketing.test",
      createdAt: agora(),
    });
    const raw = rawEmail("chato@marketing.test", "m1@marketing.test");
    await handleEmail(
      inboundMessage(raw),
      env as unknown as CloudflareBindings,
      ctx(),
    );
    await handleEmail(
      inboundMessage(raw),
      env as unknown as CloudflareBindings,
      ctx(),
    );

    const spam = await getDb().select().from(spamEmails);
    expect(spam).toHaveLength(1);
    expect(spam[0]).toMatchObject({
      fromAddress: "chato@marketing.test",
      recipient: "support@example.com",
      category: "bloqueio",
    });
    expect(await getDb().select().from(emails)).toHaveLength(0);
    // Remetente de spam não vira pessoa (busca, sugestão de destinatário).
    expect(await getDb().select().from(people)).toHaveLength(0);
  });

  it("golpe julgado pela IA vai pro Spam; legítimo entra na caixa", async () => {
    await handleEmail(
      inboundMessage(rawEmail("golpe@fraude.test", "g1@fraude.test")),
      envCom(
        iaQueResponde(
          '{"categoria":"golpe","confianca":0.97,"motivo":"phishing"}',
        ),
      ),
      ctx(),
    );
    await handleEmail(
      inboundMessage(rawEmail("cliente@empresa.test", "c1@empresa.test")),
      envCom(
        iaQueResponde(
          '{"categoria":"legitimo","confianca":0.9,"motivo":"cliente"}',
        ),
      ),
      ctx(),
    );
    const spam = await getDb().select().from(spamEmails);
    expect(spam.map((s) => [s.fromAddress, s.category, s.reason])).toEqual([
      ["golpe@fraude.test", "golpe", "phishing"],
    ]);
    const caixa = await getDb().select().from(emails);
    expect(caixa).toHaveLength(1);
  });

  it("import do Gmail: sem IA no histórico; bloqueado vai pro Spam na hora dele", async () => {
    await getDb().insert(blocklist).values({
      id: "b2",
      type: "email",
      value: "chato@marketing.test",
      createdAt: agora(),
    });
    const ia = iaQueNaoPodeSerChamada();
    const antes = agora() - 40 * 86400;
    const importar = async (from: string, id: string) =>
      ingestParsedEmail(
        getDb(),
        await parseEmail(inboundMessage(rawEmail(from, id))),
        envCom(ia),
        ctx(),
        { historical: { receivedAt: antes } },
      );

    const bloqueado = await importar("chato@marketing.test", "h1@marketing");
    expect(bloqueado.status).toBe("spam");
    expect(await importar("chato@marketing.test", "h1@marketing")).toEqual(
      bloqueado,
    );
    expect((await importar("velho@empresa.test", "h2@empresa")).status).toBe(
      "stored",
    );
    expect(ia.run).not.toHaveBeenCalled();
    const spam = await getDb().select().from(spamEmails);
    expect(spam.map((s) => [s.category, s.receivedAt])).toEqual([
      ["bloqueio", antes],
    ]);
  });
});

describe("API do Spam", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("restaurado de domínio bloqueado aparece na lista e sobrevive ao expurgo dos bloqueados", async () => {
    const { apiKey } = await createTestUser();
    await getDb().insert(blocklist).values({
      id: "dom",
      type: "domain",
      value: "cliente.test",
      createdAt: agora(),
    });
    await env.R2.put("attachments/restaurar/nota.pdf", "pdf");
    await spamRow({
      id: "restaurar",
      fromAddress: "bob@cliente.test",
      attachments: JSON.stringify([
        {
          id: "anexo",
          filename: "nota.pdf",
          contentType: "application/pdf",
          size: 3,
          r2Key: "attachments/restaurar/nota.pdf",
          contentId: null,
        },
      ]),
    });
    expect(
      (
        await authFetch("/api/spam/restaurar/not-spam", {
          apiKey,
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const lista = await (
      await authFetch("/api/people/grouped", { apiKey })
    ).json<{ data: Array<{ email: string }> }>();
    expect(lista.data.map((p) => p.email)).toContain("bob@cliente.test");
    await authFetch("/api/blocklist/mail", { apiKey, method: "DELETE" });
    expect(await getDb().select().from(emails)).toHaveLength(1);
    expect(await getDb().select().from(attachments)).toEqual([
      expect.objectContaining({ id: "anexo", emailId: "restaurar" }),
    ]);
    expect(await env.R2.get("attachments/restaurar/nota.pdf")).not.toBeNull();
    expect(await getDb().select().from(blocklist)).toHaveLength(1);
  });

  it("bloquear de novo um endereço revoga a confiança anterior", async () => {
    const { apiKey } = await createTestUser();
    await getDb()
      .insert(trustedSenders)
      .values({ email: "novo@desconhecido.test", createdAt: agora() });
    expect(
      (
        await authFetch("/api/blocklist", {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            type: "email",
            value: "novo@desconhecido.test",
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      await decidirSpam(getDb(), iaQueNaoPodeSerChamada(), email()),
    ).toMatchObject({ spam: true, category: "bloqueio" });
  });

  it("expurgo que vence a restauração não deixa e-mail com anexo apagado", async () => {
    const db = getDb();
    await env.R2.put("attachments/corrida/nota.pdf", "pdf");
    await spamRow({
      id: "corrida",
      attachments: JSON.stringify([
        {
          id: "corrida-anexo",
          filename: "nota.pdf",
          contentType: "application/pdf",
          size: 3,
          r2Key: "attachments/corrida/nota.pdf",
          contentId: null,
        },
      ]),
    });
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (ops) => {
      await apagarSpam(getDb(), env.R2, ["corrida"]);
      return batch(ops);
    });
    expect(
      await restaurarRemetente(db, "golpista@fraude.test", () => true, {
        global: true,
      }),
    ).toBe(0);
    expect(await db.select().from(emails)).toHaveLength(0);
    expect(await db.select().from(attachments)).toHaveLength(0);
  });

  it("Não é spam devolve tudo do remetente, confia nele e tira o bloqueio", async () => {
    const { apiKey } = await createTestUser();
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "email",
      value: "bob@cliente.test",
      createdAt: agora(),
    });
    const a = await spamRow({
      id: "s1",
      fromAddress: "bob@cliente.test",
      category: "bloqueio",
    });
    await spamRow({
      id: "s2",
      fromAddress: "bob@cliente.test",
      category: "bloqueio",
    });

    const lista = await authFetch("/api/spam", { apiKey });
    expect(lista.status).toBe(200);
    expect((await lista.json<{ total: number }>()).total).toBe(2);

    const r = await authFetch(`/api/spam/${a.id}/not-spam`, {
      apiKey,
      method: "POST",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ restored: 2 });

    const caixa = await getDb().select().from(emails);
    expect(caixa.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    const [bob] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "bob@cliente.test"));
    expect(bob).toMatchObject({ totalCount: 2, unreadCount: 2 });
    expect(await getDb().select().from(spamEmails)).toHaveLength(0);
    expect(await getDb().select().from(blocklist)).toHaveLength(0);
    expect(await getDb().select().from(trustedSenders)).toEqual([
      expect.objectContaining({ email: "bob@cliente.test" }),
    ]);
  });

  it("membro só vê e devolve o spam das próprias caixas, sem efeito global", async () => {
    await createTestUser({ id: "admin-1", email: "admin@example.com" });
    const { apiKey } = await createTestUser({
      id: "member-1",
      role: "member",
      email: "membro@example.com",
    });
    await getDb().insert(inboxPermissions).values({
      userId: "member-1",
      email: "support@example.com",
      createdAt: agora(),
    });
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "email",
      value: "bob@cliente.test",
      createdAt: agora(),
    });
    await spamRow({ id: "meu", fromAddress: "bob@cliente.test" });
    await spamRow({
      id: "alheio",
      fromAddress: "bob@cliente.test",
      recipient: "vendas@example.com",
    });

    const lista = await authFetch("/api/spam", { apiKey });
    const corpo = await lista.json<{ data: Array<{ id: string }> }>();
    expect(corpo.data.map((d) => d.id)).toEqual(["meu"]);
    expect((await authFetch("/api/spam/alheio", { apiKey })).status).toBe(404);
    expect(
      (await authFetch("/api/spam/alheio/not-spam", { apiKey, method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await authFetch("/api/spam/alheio", { apiKey, method: "DELETE" }))
        .status,
    ).toBe(404);

    const r = await authFetch("/api/spam/meu/not-spam", {
      apiKey,
      method: "POST",
    });
    expect(await r.json()).toEqual({ restored: 1 });
    expect((await getDb().select().from(spamEmails)).map((s) => s.id)).toEqual([
      "alheio",
    ]);
    expect(await getDb().select().from(blocklist)).toHaveLength(1);
    const listaRestaurada = await (
      await authFetch("/api/people/grouped", { apiKey })
    ).json<{ data: Array<{ email: string }> }>();
    expect(listaRestaurada.data.map((p) => p.email)).toContain(
      "bob@cliente.test",
    );
    expect(
      (
        await decidirSpam(
          getDb(),
          iaQueNaoPodeSerChamada(),
          email({ from: "bob@cliente.test" }),
        )
      ).spam,
    ).toBe(false);
    expect(
      (
        await decidirSpam(
          getDb(),
          iaQueNaoPodeSerChamada(),
          email({ from: "bob@cliente.test", to: "vendas@example.com" }),
        )
      ).spam,
    ).toBe(true);
    expect(
      await (await authFetch("/api/spam", { apiKey, method: "DELETE" })).json(),
    ).toEqual({ deleted: 0 });
    expect((await getDb().select().from(spamEmails)).map((s) => s.id)).toEqual([
      "alheio",
    ]);
  });

  it("apagar tira a linha e os anexos do R2", async () => {
    const { apiKey } = await createTestUser();
    await env.R2.put("attachments/s1/a1/nota.pdf", "pdf");
    await spamRow({
      id: "s1",
      attachments: JSON.stringify([
        {
          id: "a1",
          filename: "nota.pdf",
          contentType: "application/pdf",
          size: 3,
          r2Key: "attachments/s1/a1/nota.pdf",
          contentId: null,
        },
      ]),
    });
    const r = await authFetch("/api/spam/s1", { apiKey, method: "DELETE" });
    expect(await r.json()).toEqual({ deleted: 1 });
    expect(await env.R2.get("attachments/s1/a1/nota.pdf")).toBeNull();
    expect(await getDb().select().from(spamEmails)).toHaveLength(0);
  });

  it("stats conta o Spam no escopo de quem pergunta", async () => {
    const { apiKey } = await createTestUser();
    await spamRow({ id: "s1" });
    await spamRow({ id: "s2", recipient: "vendas@example.com" });
    const r = await authFetch("/api/stats", { apiKey });
    expect((await r.json<{ spamCount: number }>()).spamCount).toBe(2);
  });

  it("expurgo leva o que passou de 30 dias e deixa o resto", async () => {
    await spamRow({ id: "velho", receivedAt: agora() - 31 * 86_400 });
    await spamRow({ id: "novo" });
    expect(await expurgarSpamAntigo(getDb(), env.R2)).toBe(1);
    expect((await getDb().select().from(spamEmails)).map((s) => s.id)).toEqual([
      "novo",
    ]);
  });

  it("bloqueio de domínio gratuito é recusado; o endereço passa", async () => {
    const { apiKey } = await createTestUser();
    const dominio = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ type: "domain", value: "gmail.com" }),
    });
    expect(dominio.status).toBe(400);
    expect((await dominio.json<{ error: string }>()).error).toContain(
      "free email provider",
    );
    const endereco = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ type: "email", value: "chato@gmail.com" }),
    });
    expect(endereco.status).toBe(201);
  });
});
