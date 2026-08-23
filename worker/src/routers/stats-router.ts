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
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
      signatureHtml: z.string().nullable(),
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
  }>(sql`
    WITH universe AS (
      SELECT DISTINCT recipient AS email FROM ${emails}
      UNION
      SELECT email FROM ${senderIdentities}
    )
    SELECT
      u.email AS email,
      s.display_name AS displayName,
      s.signature_html AS signatureHtml
    FROM universe u
    LEFT JOIN ${senderIdentities} s ON s.email = u.email
    ORDER BY (s.email IS NULL), u.email
  `);
  const identityRows = allowed.isAdmin
    ? universe
    : universe.filter((r) => isInboxAllowed(allowed, r.email));

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: identityRows.map((r) => r.email),
      senderIdentities: identityRows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        signatureHtml: r.signatureHtml,
      })),
    },
    200,
  );
});
