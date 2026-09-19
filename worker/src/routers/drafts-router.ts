import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { replyDrafts } from "../db/reply-drafts.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { getEmailById, parseCc } from "../lib/queries/emails";
import { assertInboxAllowed, isInboxAllowed } from "../lib/inbox-permissions";
import { json200Response } from "../lib/helpers";
import { CcEntrySchema } from "./send-router";
import type { Variables } from "../variables";

/**
 * Rascunhos de resposta guardados no servidor, por usuário e por mensagem.
 *
 * Não é outbox: nada aqui sai, nem agenda, nem tem status. É só o texto que
 * o usuário ainda não enviou, para ele retomar em outro aparelho. Quem apaga
 * é o cliente, depois que o envio confirmou — o servidor nunca apaga sozinho.
 *
 * Escopo: a linha pertence ao `user.id` da sessão — o mesmo `users.id` que a
 * autenticação por API key carrega (index.ts resolve `api_keys.user_id` →
 * linha de `users` → `c.set("user", ...)`), então CLI e navegador do mesmo
 * usuário veem os mesmos rascunhos. O `emailId` precisa apontar para uma
 * mensagem em caixa permitida (mesma regra do `/send/reply`). Um id fora do
 * escopo responde 404, não 403, para não confirmar que a mensagem existe.
 *
 * Salvar exige só que a caixa seja PERMITIDA, não que ela tenha identidade de
 * envio: caixa que recebe e ainda não envia (login@…) guarda rascunho normalmente;
 * quem bloqueia o envio é o `/send/reply`, e a UI explica.
 */
export const draftsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const MAX_BODY_CHARS = 200_000;
const MAX_CC_ENTRIES = 50;

// Sem `.openapi("Nome")`: o /doc só registra componente pro caso recursivo
// (ver openapi-send-schemas.test.ts); tudo mais vai inline.
const DraftSchema = z.object({
  emailId: z.string(),
  /** Pessoa da conversa, quando a mensagem ainda existe. Deixa a caixa marcar a linha. */
  personId: z.string().nullable(),
  personEmail: z.string().nullable(),
  personName: z.string().nullable(),
  /** Assunto da mensagem respondida — para listar rascunhos sem abrir cada um. */
  subject: z.string().nullable(),
  fromAddress: z.string(),
  cc: z.array(CcEntrySchema),
  bodyHtml: z.string(),
  bodyText: z.string(),
  /** Unix segundos. */
  updatedAt: z.number(),
});

const SaveDraftSchema = z.object({
  fromAddress: z.string().email(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  bodyHtml: z.string().max(MAX_BODY_CHARS),
  bodyText: z.string().max(MAX_BODY_CHARS),
});

const ErrorSchema = z.object({ error: z.string() });

type Meta = {
  personId: string | null;
  personEmail: string | null;
  personName: string | null;
  subject: string | null;
};

function rowToDraft(row: typeof replyDrafts.$inferSelect, meta: Meta) {
  return {
    emailId: row.emailId,
    ...meta,
    fromAddress: row.fromAddress,
    cc: parseCc(row.cc),
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    updatedAt: row.updatedAt,
  };
}

/** Meta a partir do detalhe que `getEmailById` já devolve (rotas de um só). */
function metaDoEmail(
  email: NonNullable<Awaited<ReturnType<typeof getEmailById>>>,
): Meta {
  return {
    personId: email.personId ?? null,
    // Recebido: quem escreveu é a pessoa. Nosso: a pessoa é o destinatário.
    personEmail:
      (email.type === "received" ? email.fromAddress : email.toAddress) ?? null,
    personName: null,
    subject: email.subject ?? null,
  };
}

// --- GET /api/drafts -------------------------------------------------------
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Drafts"],
  description:
    "Reply drafts saved by the current user, newest first. Drafts whose message is no longer in an allowed inbox are omitted.",
  responses: {
    ...json200Response(
      z.object({ drafts: z.array(DraftSchema) }),
      "Drafts of the current user",
    ),
  },
});

draftsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const allowed = c.get("allowedInboxes")!;

  // Um LEFT JOIN por tabela de origem: o alvo da resposta pode ser recebido
  // (`emails`) ou nosso (`sent_emails`), como no /send/reply. Caixa, pessoa e
  // assunto saem da mesma linha, para o filtro de permissão e a listagem não
  // custarem uma consulta por rascunho.
  const personId = sql<
    string | null
  >`coalesce(${emails.personId}, ${sentEmails.personId})`;
  const rows = await db
    .select({
      draft: replyDrafts,
      personId,
      personEmail: people.email,
      personName: people.name,
      receivedInbox: emails.recipient,
      sentInbox: sentEmails.fromAddress,
      receivedSubject: emails.subject,
      sentSubject: sentEmails.subject,
    })
    .from(replyDrafts)
    .leftJoin(emails, eq(emails.id, replyDrafts.emailId))
    .leftJoin(sentEmails, eq(sentEmails.id, replyDrafts.emailId))
    .leftJoin(people, eq(people.id, personId))
    .where(eq(replyDrafts.userId, user.id));

  const drafts = rows
    .filter((r) => {
      const inbox = r.receivedInbox ?? r.sentInbox;
      return inbox !== null && isInboxAllowed(allowed, inbox);
    })
    .sort((a, b) => b.draft.updatedAt - a.draft.updatedAt)
    .map((r) =>
      rowToDraft(r.draft, {
        personId: r.personId ?? null,
        personEmail: r.personEmail ?? null,
        personName: r.personName ?? null,
        subject: r.receivedSubject ?? r.sentSubject ?? null,
      }),
    );

  return c.json({ drafts }, 200);
});

// --- GET /api/drafts/{emailId} --------------------------------------------
const getRoute = createRoute({
  method: "get",
  path: "/{emailId}",
  tags: ["Drafts"],
  description: "The current user's draft reply to one message.",
  request: { params: z.object({ emailId: z.string() }) },
  responses: {
    ...json200Response(DraftSchema, "Draft"),
    404: {
      description: "No draft, or message not visible to this user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

draftsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const allowed = c.get("allowedInboxes")!;
  const { emailId } = c.req.valid("param");

  const email = await getEmailById(db, emailId, allowed);
  if (!email) return c.json({ error: "Draft not found" }, 404);

  const row = await db
    .select()
    .from(replyDrafts)
    .where(
      and(eq(replyDrafts.userId, user.id), eq(replyDrafts.emailId, emailId)),
    )
    .limit(1);
  if (row.length === 0) return c.json({ error: "Draft not found" }, 404);

  return c.json(rowToDraft(row[0], metaDoEmail(email)), 200);
});

// --- PUT /api/drafts/{emailId} --------------------------------------------
const putRoute = createRoute({
  method: "put",
  path: "/{emailId}",
  tags: ["Drafts"],
  description:
    "Create or replace the current user's draft reply to a message. Does not send or schedule anything. " +
    "With `If-None-Match: *` the draft is only created, never replaced: an existing draft answers 412 and is left untouched " +
    "(for automation that must not overwrite what the user typed).",
  request: {
    params: z.object({ emailId: z.string() }),
    headers: z.object({
      "if-none-match": z.string().optional(),
    }),
    body: {
      content: { "application/json": { schema: SaveDraftSchema } },
    },
  },
  responses: {
    ...json200Response(DraftSchema, "Draft saved"),
    403: {
      description: "fromAddress is not an inbox this user may send from",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Message not visible to this user",
      content: { "application/json": { schema: ErrorSchema } },
    },
    412: {
      description: "`If-None-Match: *` was sent and a draft already exists",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

draftsRouter.openapi(putRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const allowed = c.get("allowedInboxes")!;
  const { emailId } = c.req.valid("param");
  const body = c.req.valid("json");
  const somenteCriar = c.req.header("if-none-match")?.trim() === "*";

  const email = await getEmailById(db, emailId, allowed);
  if (!email) return c.json({ error: "Email not found" }, 404);
  // Mesma guarda do envio: guardar um "De:" que o usuário não pode usar só
  // adia o 403 para a hora de mandar.
  assertInboxAllowed(allowed, body.fromAddress);

  const now = Math.floor(Date.now() / 1000);
  const values = {
    userId: user.id as string,
    emailId,
    fromAddress: body.fromAddress.toLowerCase(),
    cc: body.cc && body.cc.length > 0 ? JSON.stringify(body.cc) : null,
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyText,
    updatedAt: now,
  };

  if (somenteCriar) {
    // Uma única instrução: INSERT ... ON CONFLICT DO NOTHING. Sem SELECT antes,
    // então duas criações concorrentes não passam as duas.
    const inserted = await db
      .insert(replyDrafts)
      .values(values)
      .onConflictDoNothing({
        target: [replyDrafts.userId, replyDrafts.emailId],
      })
      .returning({ emailId: replyDrafts.emailId });
    if (inserted.length === 0) {
      return c.json({ error: "Draft already exists" }, 412);
    }
    return c.json(rowToDraft(values, metaDoEmail(email)), 200);
  }

  await db
    .insert(replyDrafts)
    .values(values)
    .onConflictDoUpdate({
      target: [replyDrafts.userId, replyDrafts.emailId],
      set: {
        fromAddress: values.fromAddress,
        cc: values.cc,
        bodyHtml: values.bodyHtml,
        bodyText: values.bodyText,
        updatedAt: values.updatedAt,
      },
    });

  return c.json(rowToDraft(values, metaDoEmail(email)), 200);
});

// --- DELETE /api/drafts/{emailId} -----------------------------------------
const deleteRoute = createRoute({
  method: "delete",
  path: "/{emailId}",
  tags: ["Drafts"],
  description:
    "Discard the current user's draft reply to a message. Idempotent: 204 whether or not a draft existed.",
  request: { params: z.object({ emailId: z.string() }) },
  responses: { 204: { description: "Draft discarded" } },
});

draftsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const { emailId } = c.req.valid("param");

  // Só a linha do próprio usuário: sem checar a caixa, porque quem perdeu
  // acesso à caixa ainda deve poder descartar o que escreveu.
  await db
    .delete(replyDrafts)
    .where(
      and(eq(replyDrafts.userId, user.id), eq(replyDrafts.emailId, emailId)),
    );

  return c.body(null, 204);
});
