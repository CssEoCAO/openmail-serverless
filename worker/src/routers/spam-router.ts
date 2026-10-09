import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { spamEmails } from "../db/spam.schema";
import { json200Response } from "../lib/helpers";
import { inboxFilter, isInboxAllowed } from "../lib/inbox-permissions";
import { apagarSpam, restaurarRemetente, textoDoCorpo } from "../lib/spam";
import type { Variables } from "../variables";

export const spamRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CategoriaSchema = z.enum([
  "golpe",
  "prospeccao",
  "bloqueio",
  "reincidente",
]);

const ItemSchema = z.object({
  id: z.string(),
  from: z.string(),
  fromName: z.string().nullable(),
  recipient: z.string(),
  subject: z.string().nullable(),
  snippet: z.string(),
  category: CategoriaSchema,
  reason: z.string().nullable(),
  confidence: z.number().nullable(),
  receivedAt: z.number(),
  attachmentCount: z.number(),
});

const ListSchema = z.object({
  data: z.array(ItemSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

const DetailSchema = ItemSchema.extend({
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
    }),
  ),
});

const ErrorSchema = z.object({ error: z.string() });
const IdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const notFound = {
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

type Linha = {
  id: string;
  fromAddress: string;
  fromName: string | null;
  recipient: string;
  subject: string | null;
  trecho: string | null;
  category: string;
  reason: string | null;
  confidence: number | null;
  receivedAt: number;
  anexos: number;
};

const colunas = {
  id: spamEmails.id,
  fromAddress: spamEmails.fromAddress,
  fromName: spamEmails.fromName,
  recipient: spamEmails.recipient,
  subject: spamEmails.subject,
  // A lista não carrega o corpo inteiro: 600 caracteres bastam pro trecho.
  trecho: sql<
    string | null
  >`substr(coalesce(${spamEmails.bodyText}, ${spamEmails.bodyHtml}), 1, 600)`,
  category: spamEmails.category,
  reason: spamEmails.reason,
  confidence: spamEmails.confidence,
  receivedAt: spamEmails.receivedAt,
  anexos: sql<number>`coalesce(json_array_length(${spamEmails.attachments}), 0)`,
};

function toItem(r: Linha) {
  const html = /<[a-z!]/i.test(r.trecho ?? "") ? r.trecho : null;
  return {
    id: r.id,
    from: r.fromAddress,
    fromName: r.fromName,
    recipient: r.recipient,
    subject: r.subject,
    snippet: textoDoCorpo(html ? null : r.trecho, html).slice(0, 160),
    category: r.category as z.infer<typeof CategoriaSchema>,
    reason: r.reason,
    confidence: r.confidence,
    receivedAt: r.receivedAt,
    attachmentCount: r.anexos,
  };
}

// --- GET /api/spam ---
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Spam"],
  description:
    "Spam das caixas que o usuário vê, do mais novo para o mais antigo. Some sozinho depois de 30 dias.",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: { ...json200Response(ListSchema, "Página do Spam") },
});

spamRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const q = c.req.valid("query");
  const page = Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1);
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(q.limit ?? "30", 10) || 30),
  );
  const escopo = inboxFilter(allowed, spamEmails.recipient) ?? sql`1=1`;

  const [contagem] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(spamEmails)
    .where(escopo);
  const linhas = await db
    .select(colunas)
    .from(spamEmails)
    .where(escopo)
    .orderBy(desc(spamEmails.receivedAt), desc(spamEmails.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return c.json(
    { data: linhas.map(toItem), total: contagem?.total ?? 0, page, limit },
    200,
  );
});

// --- GET /api/spam/{id} ---
const detailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Spam"],
  description: "Uma mensagem do Spam, com corpo e lista de anexos.",
  request: { params: IdParam },
  responses: { ...json200Response(DetailSchema, "Mensagem"), ...notFound },
});

spamRouter.openapi(detailRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const [s] = await db
    .select()
    .from(spamEmails)
    .where(eq(spamEmails.id, id))
    .limit(1);
  // 404 também para caixa de outro: não confirma que o id existe.
  if (!s || !isInboxAllowed(allowed, s.recipient)) {
    return c.json({ error: "Not found" }, 404);
  }
  let anexos: Array<{ filename: string; contentType: string; size: number }> =
    [];
  try {
    anexos = (JSON.parse(s.attachments ?? "[]") as typeof anexos).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    }));
  } catch {
    anexos = [];
  }
  return c.json(
    {
      ...toItem({
        ...s,
        trecho: (s.bodyText ?? s.bodyHtml ?? "").slice(0, 600),
        anexos: anexos.length,
      }),
      bodyHtml: s.bodyHtml,
      bodyText: s.bodyText,
      attachments: anexos,
    },
    200,
  );
});

// --- POST /api/spam/{id}/not-spam ---
const restoreRoute = createRoute({
  method: "post",
  path: "/{id}/not-spam",
  tags: ["Spam"],
  description:
    "Não é spam: devolve e libera o remetente nas caixas restauradas. Feito por admin, a confiança é global e o bloqueio do endereço é removido.",
  request: { params: IdParam },
  responses: {
    ...json200Response(z.object({ restored: z.number() }), "Devolvidos"),
    ...notFound,
  },
});

spamRouter.openapi(restoreRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const [s] = await db
    .select({
      fromAddress: spamEmails.fromAddress,
      recipient: spamEmails.recipient,
    })
    .from(spamEmails)
    .where(eq(spamEmails.id, id))
    .limit(1);
  if (!s || !isInboxAllowed(allowed, s.recipient)) {
    return c.json({ error: "Not found" }, 404);
  }
  const restored = await restaurarRemetente(
    db,
    s.fromAddress,
    (recipient) => isInboxAllowed(allowed, recipient),
    { global: allowed.isAdmin },
  );
  return c.json({ restored }, 200);
});

// --- DELETE /api/spam/{id} ---
const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Spam"],
  description: "Apaga de vez uma mensagem do Spam, com os anexos.",
  request: { params: IdParam },
  responses: {
    ...json200Response(z.object({ deleted: z.number() }), "Apagada"),
    ...notFound,
  },
});

spamRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const [s] = await db
    .select({ recipient: spamEmails.recipient })
    .from(spamEmails)
    .where(eq(spamEmails.id, id))
    .limit(1);
  if (!s || !isInboxAllowed(allowed, s.recipient)) {
    return c.json({ error: "Not found" }, 404);
  }
  const deleted = await apagarSpam(db, c.env.R2, [id]);
  return c.json({ deleted }, 200);
});

// --- DELETE /api/spam ---
const emptyRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Spam"],
  description: "Esvazia o Spam das caixas que o usuário vê.",
  responses: {
    ...json200Response(z.object({ deleted: z.number() }), "Esvaziado"),
  },
});

spamRouter.openapi(emptyRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const ids = await db
    .select({ id: spamEmails.id })
    .from(spamEmails)
    .where(and(inboxFilter(allowed, spamEmails.recipient) ?? sql`1=1`));
  const deleted = await apagarSpam(
    db,
    c.env.R2,
    ids.map((r) => r.id),
  );
  return c.json({ deleted }, 200);
});
