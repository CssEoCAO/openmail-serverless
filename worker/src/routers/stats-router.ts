import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, sql } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import { inboxFilter, isInboxAllowed } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  // `recipients` e `senderIdentities` sao quem pode ENVIAR (linha em sender_identities).
  // `inboxes` e quem RECEBE. Sao listas diferentes e confundi-las quebra os dois lados:
  // oferecer no "De:" um endereco sem identidade faz o envio cair no provedor default e
  // falhar; e filtrar so pelas identidades esconde as caixas de catch-all que so recebem.
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
      signatureHtml: z.string().nullable(),
    }),
  ),
  inboxes: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
      podeEnviar: z.boolean(),
      total: z.number(),
      naoLidas: z.number(),
      ultima: z.number().nullable(),
    }),
  ),
});

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  description:
    "Get inbox statistics (filtered to caller's accessible inboxes).",
  request: {
    query: z.object({
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
    }),
  },
  responses: {
    ...json200Response(StatsSchema, "Inbox statistics"),
  },
});

statsRouter.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { recipient } = c.req.valid("query");

  const scopeFilter = inboxFilter(allowed, emails.recipient);
  const recipientFilter = recipient
    ? sql`${emails.recipient} = ${recipient}`
    : undefined;

  const whereEmails = and(scopeFilter, recipientFilter);

  const emailAgg = await db
    .select({
      total: sql<number>`COUNT(*)`,
      unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
    })
    .from(emails)
    .where(whereEmails ?? sql`1=1`);
  const totalEmails = emailAgg[0]?.total ?? 0;
  const unreadCount = emailAgg[0]?.unread ?? 0;

  const personCountRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(people)
    .where(
      allowed.isAdmin
        ? sql`1=1`
        : allowed.inboxes.length === 0
          ? sql`0`
          : sql`${people.id} IN (SELECT person_id FROM ${emails} WHERE ${emails.recipient} IN ${allowed.inboxes})`,
    );

  // An inbox is any address that has received mail, plus any configured
  // sender identity -- the same universe GET /api/admin/inboxes reports.
  // Reading sender_identities alone hid every catch-all address that was
  // never given custom config, and that table is deliberately sparse: the
  // PUT handler deletes a row once all its fields are back at defaults, so
  // an inbox could drop out of this list just by clearing its display name.
  // Configured identities sort first because ComposeModal defaults the From
  // field to recipients[0], which must stay an address someone set up.
  const universe = await db.all<{
    email: string;
    displayName: string | null;
    signatureHtml: string | null;
    configurada: number;
    total: number;
    naoLidas: number;
    ultima: number | null;
  }>(sql`
    WITH universe AS (
      SELECT DISTINCT recipient AS email FROM ${emails}
      UNION
      SELECT email FROM ${senderIdentities}
    ),
    -- Um GROUP BY recipient para a tela de escolha de caixa, em vez de uma chamada
    -- por caixa (N+1). Anda pelo emails_recipient_received_idx, que ja e' liderado por
    -- recipient. Nao ha indice sobre is_read em lugar nenhum do schema, entao a soma
    -- de nao-lidas le as linhas do grupo — barato na ordem de grandeza de hoje, e o
    -- teto e' o tamanho da caixa, nao o numero de caixas.
    contagem AS (
      SELECT recipient,
             COUNT(*) AS total,
             SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS naoLidas,
             MAX(received_at) AS ultima
      FROM ${emails}
      GROUP BY recipient
    )
    SELECT
      u.email AS email,
      s.display_name AS displayName,
      s.signature_html AS signatureHtml,
      (s.email IS NOT NULL) AS configurada,
      COALESCE(c.total, 0) AS total,
      COALESCE(c.naoLidas, 0) AS naoLidas,
      c.ultima AS ultima
    FROM universe u
    LEFT JOIN ${senderIdentities} s ON s.email = u.email
    LEFT JOIN contagem c ON c.recipient = u.email
    -- Identidade configurada primeiro: a lista de remetentes sai desta mesma ordem,
    -- e o ComposeModal usa o primeiro item dela como remetente default.
    ORDER BY (s.email IS NULL), u.email
  `);
  const visiveis = allowed.isAdmin
    ? universe
    : universe.filter((r) => isInboxAllowed(allowed, r.email));
  // Enviar exige linha em sender_identities: e ela que carrega o `outbound_provider`.
  // Sem ela o envio cai no provedor default e falha na cara do usuario -- foi o que
  // aconteceu com contact@example.com em 23/08/2026.
  const podemEnviar = visiveis.filter((r) => !!r.configurada);

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: podemEnviar.map((r) => r.email),
      senderIdentities: podemEnviar.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        signatureHtml: r.signatureHtml,
      })),
      inboxes: visiveis.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        podeEnviar: !!r.configurada,
        total: r.total ?? 0,
        naoLidas: r.naoLidas ?? 0,
        ultima: r.ultima ?? null,
      })),
    },
    200,
  );
});
