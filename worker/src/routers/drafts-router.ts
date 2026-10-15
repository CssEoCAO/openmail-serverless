import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, like, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { getEmailById, parseCc } from "../lib/queries/emails";
import { assertInboxAllowed, isInboxAllowed } from "../lib/inbox-permissions";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import { CcEntrySchema } from "./send-router";
import type { Variables } from "../variables";

/**
 * Autosaved drafts, one table (`drafts`), one router.
 *
 * A draft is identified by `(userId, contextKey)`:
 *   - `"compose"`         — the new-message composer (one per user)
 *   - `"reply:<emailId>"` — the reply to one message (`emailId` is a row of
 *     `emails` or `sent_emails`, as in `/send/reply`)
 *
 * Nothing here is an outbox: nothing is sent, scheduled or has a status. It is
 * the text the user has not sent yet, kept on the server so they can resume on
 * another device. The client deletes it after the send is confirmed; the server
 * never deletes on its own.
 *
 * Scope: the row belongs to the session's `user.id` — the same `users.id` that
 * API-key auth carries — so the CLI and the browser of one user see the same
 * drafts. For a `reply:` key the message must be in an allowed inbox (the same
 * rule as `/send/reply`); a message out of scope answers 404, not 403, so it
 * does not confirm the message exists.
 *
 * Three ways in, same rows:
 *   - `GET|PUT|DELETE /api/drafts?contextKey=…` — what the web app and WebMCP use;
 *   - `GET /api/drafts` (no contextKey) — the user's reply drafts, for the
 *     "Drafts" filter of the inbox;
 *   - `GET|PUT|DELETE /api/drafts/{emailId}` — a reply draft by message id, for
 *     scripts (supports `If-None-Match: *`).
 */

const MAX_BODY_CHARS = 200_000;
const MAX_CC_ENTRIES = 50;
const REPLY_PREFIX = "reply:";

const replyKey = (emailId: string) => `${REPLY_PREFIX}${emailId}`;

const ErrorSchema = z.object({ error: z.string() });

/** The shape of one draft row returned to the client — cc parsed back. */
const DraftSchema = z.object({
  id: z.string(),
  contextKey: z.string(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  cc: z.array(CcEntrySchema).nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  replyToEmailId: z.string().nullable(),
  updatedAt: z.number(),
});

/** A reply draft with the conversation it belongs to — the inbox list item. */
const ReplyDraftItemSchema = z.object({
  emailId: z.string(),
  /** Person of the conversation, when the message still exists. */
  personId: z.string().nullable(),
  personEmail: z.string().nullable(),
  personName: z.string().nullable(),
  /** Subject of the message being answered — list drafts without opening each. */
  subject: z.string().nullable(),
  fromAddress: z.string(),
  cc: z.array(CcEntrySchema),
  bodyHtml: z.string(),
  bodyText: z.string(),
  /** Unix seconds. */
  updatedAt: z.number(),
});

type DraftRow = typeof drafts.$inferSelect;
type Meta = {
  personId: string | null;
  personEmail: string | null;
  personName: string | null;
  subject: string | null;
};

function toDraft(row: DraftRow): z.infer<typeof DraftSchema> {
  return {
    id: row.id,
    contextKey: row.contextKey,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    cc: row.cc ? parseCc(row.cc) : null,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    replyToEmailId: row.replyToEmailId,
    updatedAt: row.updatedAt,
  };
}

function toReplyItem(row: DraftRow, emailId: string, meta: Meta) {
  return {
    emailId,
    ...meta,
    fromAddress: row.fromAddress ?? "",
    cc: parseCc(row.cc),
    bodyHtml: row.bodyHtml ?? "",
    bodyText: row.bodyText ?? "",
    updatedAt: row.updatedAt,
  };
}

/** Meta from the detail `getEmailById` already returns (single-draft routes). */
function metaOfEmail(
  email: NonNullable<Awaited<ReturnType<typeof getEmailById>>>,
): Meta {
  return {
    personId: email.personId ?? null,
    // Received: the person is who wrote. Ours: the person is the recipient.
    personEmail:
      (email.type === "received" ? email.fromAddress : email.toAddress) ?? null,
    personName: null,
    subject: email.subject ?? null,
  };
}

export const draftsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- GET /api/drafts[?contextKey=…] ----------------------------------------
const ContextQuery = z.object({
  contextKey: z.string().min(1).max(200).optional(),
});

const getDraftRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "With `contextKey`: the current user's autosaved draft for that compose surface, or `null`. " +
    "Without it: the user's reply drafts, newest first (messages no longer in an allowed inbox are omitted).",
  request: { query: ContextQuery },
  responses: {
    ...json200Response(
      z.union([
        z.object({ draft: DraftSchema.nullable() }),
        z.object({ drafts: z.array(ReplyDraftItemSchema) }),
      ]),
      "The draft (or null) for a contextKey; otherwise the list of reply drafts",
    ),
  },
});

draftsRouter.openapi(getDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const allowed = c.get("allowedInboxes")!;
  const { contextKey } = c.req.valid("query");

  if (contextKey) {
    const rows = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)))
      .limit(1);
    return c.json({ draft: rows[0] ? toDraft(rows[0]) : null }, 200);
  }

  // One LEFT JOIN per source table: the reply target may be received
  // (`emails`) or ours (`sent_emails`), as in /send/reply. Inbox, person and
  // subject come from the same row, so the permission filter and the list do
  // not cost a query per draft.
  const personId = sql<
    string | null
  >`coalesce(${emails.personId}, ${sentEmails.personId})`;
  const rows = await db
    .select({
      draft: drafts,
      personId,
      personEmail: people.email,
      personName: people.name,
      receivedInbox: emails.recipient,
      sentInbox: sentEmails.fromAddress,
      receivedSubject: emails.subject,
      sentSubject: sentEmails.subject,
    })
    .from(drafts)
    .leftJoin(emails, eq(emails.id, drafts.replyToEmailId))
    .leftJoin(sentEmails, eq(sentEmails.id, drafts.replyToEmailId))
    .leftJoin(people, eq(people.id, personId))
    .where(
      and(
        eq(drafts.userId, user.id),
        like(drafts.contextKey, `${REPLY_PREFIX}%`),
      ),
    );

  const list = rows
    .filter((r) => {
      const inbox = r.receivedInbox ?? r.sentInbox;
      return inbox !== null && isInboxAllowed(allowed, inbox);
    })
    .sort((a, b) => b.draft.updatedAt - a.draft.updatedAt)
    .map((r) =>
      toReplyItem(r.draft, r.draft.replyToEmailId!, {
        personId: r.personId ?? null,
        personEmail: r.personEmail ?? null,
        personName: r.personName ?? null,
        subject: r.receivedSubject ?? r.sentSubject ?? null,
      }),
    );

  return c.json({ drafts: list }, 200);
});

// --- PUT /api/drafts -------------------------------------------------------
const SaveDraftBody = z.object({
  contextKey: z.string().min(1).max(200),
  fromAddress: z.string().max(320).optional(),
  // A draft `to` may be a partial/incomplete address while the user types,
  // so it is deliberately NOT validated as an email here.
  to: z.string().max(320).optional(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  subject: z.string().max(2000).optional(),
  bodyHtml: z.string().max(MAX_BODY_CHARS).optional(),
  bodyText: z.string().max(MAX_BODY_CHARS).optional(),
  replyToEmailId: z.string().nullable().optional(),
});

const saveDraftRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Create or update (upsert) the autosaved draft for a compose surface. " +
    "For `reply:<emailId>` the message must be visible to the user and `fromAddress` an inbox they may send from.",
  request: {
    body: {
      content: { "application/json": { schema: SaveDraftBody } },
    },
  },
  responses: {
    ...json200Response(z.object({ draft: DraftSchema }), "The saved draft"),
    403: {
      description: "fromAddress is not an inbox this user may send from",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Message not visible to this user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

draftsRouter.openapi(saveDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const allowed = c.get("allowedInboxes")!;
  const body = c.req.valid("json");

  let replyToEmailId = body.replyToEmailId ?? null;
  if (body.contextKey.startsWith(REPLY_PREFIX)) {
    const emailId = body.contextKey.slice(REPLY_PREFIX.length);
    if (!emailId || !(await getEmailById(db, emailId, allowed))) {
      return c.json({ error: "Email not found" }, 404);
    }
    replyToEmailId = emailId;
  }
  // Same guard as sending: saving a "From" the user cannot use only moves the
  // 403 to the moment of sending.
  if (body.fromAddress) assertInboxAllowed(allowed, body.fromAddress);

  const now = Math.floor(Date.now() / 1000);
  const cc = body.cc && body.cc.length > 0 ? JSON.stringify(body.cc) : null;
  const values = {
    fromAddress: body.fromAddress?.toLowerCase() ?? null,
    toAddress: body.to ?? null,
    cc,
    subject: body.subject ?? null,
    bodyHtml: body.bodyHtml ?? null,
    bodyText: body.bodyText ?? null,
    replyToEmailId,
    updatedAt: now,
  };

  await db
    .insert(drafts)
    .values({
      id: nanoid(),
      userId: user.id,
      contextKey: body.contextKey,
      createdAt: now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [drafts.userId, drafts.contextKey],
      set: values,
    });

  const rows = await db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.userId, user.id), eq(drafts.contextKey, body.contextKey)),
    )
    .limit(1);
  return c.json({ draft: toDraft(rows[0]) }, 200);
});

// --- DELETE /api/drafts?contextKey=… ---------------------------------------
const deleteDraftRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description: "Delete the current user's draft for a compose surface.",
  request: { query: z.object({ contextKey: z.string().min(1).max(200) }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Draft deleted"),
  },
});

draftsRouter.openapi(deleteDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const { contextKey } = c.req.valid("query");
  // Only the user's own row, without checking the inbox: whoever lost access
  // to the inbox must still be able to discard what they wrote.
  await db
    .delete(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)));
  return c.json({ success: true }, 200);
});

// --- GET /api/drafts/{emailId} ---------------------------------------------
const SaveReplyDraftSchema = z.object({
  fromAddress: z.string().email(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  bodyHtml: z.string().max(MAX_BODY_CHARS),
  bodyText: z.string().max(MAX_BODY_CHARS),
});

const getRoute = createRoute({
  method: "get",
  path: "/{emailId}",
  tags: ["Drafts"],
  security: bearerSecurity,
  description: "The current user's draft reply to one message.",
  request: { params: z.object({ emailId: z.string() }) },
  responses: {
    ...json200Response(ReplyDraftItemSchema, "Draft"),
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
    .from(drafts)
    .where(
      and(eq(drafts.userId, user.id), eq(drafts.contextKey, replyKey(emailId))),
    )
    .limit(1);
  if (row.length === 0) return c.json({ error: "Draft not found" }, 404);

  return c.json(toReplyItem(row[0], emailId, metaOfEmail(email)), 200);
});

// --- PUT /api/drafts/{emailId} ---------------------------------------------
const putRoute = createRoute({
  method: "put",
  path: "/{emailId}",
  tags: ["Drafts"],
  security: bearerSecurity,
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
      content: { "application/json": { schema: SaveReplyDraftSchema } },
    },
  },
  responses: {
    ...json200Response(ReplyDraftItemSchema, "Draft saved"),
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
  const createOnly = c.req.header("if-none-match")?.trim() === "*";

  const email = await getEmailById(db, emailId, allowed);
  if (!email) return c.json({ error: "Email not found" }, 404);
  assertInboxAllowed(allowed, body.fromAddress);

  const now = Math.floor(Date.now() / 1000);
  const values = {
    fromAddress: body.fromAddress.toLowerCase(),
    toAddress: null,
    cc: body.cc && body.cc.length > 0 ? JSON.stringify(body.cc) : null,
    subject: null,
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyText,
    replyToEmailId: emailId,
    updatedAt: now,
  };
  const row: DraftRow = {
    id: nanoid(),
    userId: user.id,
    contextKey: replyKey(emailId),
    createdAt: now,
    ...values,
  };

  if (createOnly) {
    // A single statement: INSERT ... ON CONFLICT DO NOTHING. No SELECT first,
    // so two concurrent creations cannot both pass.
    const inserted = await db
      .insert(drafts)
      .values(row)
      .onConflictDoNothing({ target: [drafts.userId, drafts.contextKey] })
      .returning({ id: drafts.id });
    if (inserted.length === 0) {
      return c.json({ error: "Draft already exists" }, 412);
    }
    return c.json(toReplyItem(row, emailId, metaOfEmail(email)), 200);
  }

  await db
    .insert(drafts)
    .values(row)
    .onConflictDoUpdate({
      target: [drafts.userId, drafts.contextKey],
      set: values,
    });

  return c.json(toReplyItem(row, emailId, metaOfEmail(email)), 200);
});

// --- DELETE /api/drafts/{emailId} ------------------------------------------
const deleteRoute = createRoute({
  method: "delete",
  path: "/{emailId}",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Discard the current user's draft reply to a message. Idempotent: 204 whether or not a draft existed.",
  request: { params: z.object({ emailId: z.string() }) },
  responses: { 204: { description: "Draft discarded" } },
});

draftsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user")!;
  const { emailId } = c.req.valid("param");

  await db
    .delete(drafts)
    .where(
      and(eq(drafts.userId, user.id), eq(drafts.contextKey, replyKey(emailId))),
    );

  return c.body(null, 204);
});
