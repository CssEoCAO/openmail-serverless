import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, ne } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { isInboxAllowed } from "../lib/inbox-permissions";
import { sanitizeFilename } from "../lib/sanitize-filename";
import type { Variables } from "../variables";

export const attachmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Attachment metadata comes from untrusted inbound MIME. In particular, an
// attacker can label a body as text/html or image/svg+xml. These headers keep a
// direct navigation to the authenticated inline URL from becoming same-origin
// script execution while preserving ordinary CID images and PDF previews.
const attachmentSecurityHeaders = {
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

// The owning inbox is `emails.recipient` for inbound and
// `sent_emails.from_address` for sent — the external `to_address` is nobody's
// inbox. A single query left-joins the owner from whichever table `kind`
// selects; the join predicate carries the `kind` test so only one side ever
// matches. Null covers both "message row gone" (orphaned, fails closed) and
// "not allowed" so both answer 404; a 403 would confirm the id exists.
async function findReadableAttachment(
  db: Variables["db"],
  allowed: NonNullable<Variables["allowedInboxes"]>,
  id: string,
) {
  const rows = await db
    .select({
      attachment: attachments,
      sentInbox: sentEmails.fromAddress,
      inboundInbox: emails.recipient,
    })
    .from(attachments)
    .leftJoin(
      emails,
      and(ne(attachments.kind, "sent"), eq(emails.id, attachments.emailId)),
    )
    .leftJoin(
      sentEmails,
      and(eq(attachments.kind, "sent"), eq(sentEmails.id, attachments.emailId)),
    )
    .where(eq(attachments.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const { attachment, sentInbox, inboundInbox } = rows[0];

  const owner = attachment.kind === "sent" ? sentInbox : inboundInbox;
  // Null owner = orphaned message row (or unset address). Fail closed.
  if (owner === null || !isInboxAllowed(allowed, owner)) return null;

  return attachment;
}

const downloadRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Attachments"],
  description:
    "Download an attachment from R2. Scoped to the caller's allowed inboxes.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Attachment file" },
    404: { description: "Attachment not found, or not in an allowed inbox" },
  },
});

attachmentsRouter.openapi(downloadRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const att = await findReadableAttachment(db, allowed, id);
  if (!att) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att.r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  // Sanitize before interpolating into the header: a raw filename can carry
  // quotes or CR/LF and split the response. `filename*` (RFC 5987) carries the
  // full value for clients that honour it.
  const safeFilename = sanitizeFilename(att.filename).replaceAll('"', "_");

  return new Response(object.body, {
    headers: {
      ...attachmentSecurityHeaders,
      "Content-Type": att.contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
      "Content-Length": att.size.toString(),
      "Cache-Control": "private, no-store",
    },
  });
});

// Serve attachment inline (for CID images in email HTML)
const inlineRoute = createRoute({
  method: "get",
  path: "/{id}/inline",
  tags: ["Attachments"],
  description:
    "Serve an attachment inline (for embedded images). Scoped to the caller's allowed inboxes.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Inline attachment" },
    404: { description: "Attachment not found, or not in an allowed inbox" },
  },
});

attachmentsRouter.openapi(inlineRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const att = await findReadableAttachment(db, allowed, id);
  if (!att) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att.r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      ...attachmentSecurityHeaders,
      "Content-Type": att.contentType,
      "Content-Disposition": "inline",
      "Content-Length": att.size.toString(),
      // Browser caches also outlive logout/permission revocation in the same
      // profile, so authenticated mailbox bytes must be re-authorized.
      "Cache-Control": "private, no-store",
    },
  });
});
