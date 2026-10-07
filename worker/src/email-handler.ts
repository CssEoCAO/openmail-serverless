import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { people } from "./db/people.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { inboxPermissions } from "./db/inbox-permissions.schema";
import { senderIdentities } from "./db/sender-identities.schema";
import { users } from "./db/auth.schema";
import { parseEmail } from "./lib/email-parser";
import { isBlocked } from "./lib/blocklist";
import { computeConversationId, externalsOnly } from "./lib/conversation-id";
import { cancelSequencesForPerson } from "./lib/cancel-sequence";
import {
  MAX_ADMIN_FANOUT,
  MAX_TOTAL_FANOUT,
  computeFanoutTargets,
} from "./lib/notification-fanout";
import { sanitizeFilename } from "./lib/sanitize-filename";
import { buildWebhookPayload, deliverWebhook } from "./lib/webhook-delivery";
import { forwardInbound } from "./lib/inbound-forward";
import { fitsD1EmailTextBudget } from "./lib/email-limits";

const MAX_ATTACHMENTS = 50;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_RAW_EMAIL_BYTES = 25 * 1024 * 1024;

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  // PostalMime needs the complete RFC 822 message in memory. Check the
  // platform-provided byte count before buffering so an oversized delivery
  // cannot exhaust the Worker's 128 MiB isolate.
  if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
    message.setReject("Message too large");
    return;
  }

  const db = drizzle(env.DB, { schema });
  const parsed = await parseEmail(message);
  const now = Math.floor(Date.now() / 1000);

  // Canonicalize inbox addresses to lowercase before storage so casing
  // variants of the same recipient don't fork into separate group-row
  // buckets (the grouped query keys by `(conversation_id, inbox)`, and
  // conversation_id is computed from lowercased inputs already — we
  // need the stored column to match).
  const recipientCanonical = parsed.to.trim().toLowerCase();
  const fromAddressCanonical = parsed.from.address.trim().toLowerCase();
  // Only an aligned DMARC verdict from Cloudflare's authentication service is
  // strong enough for sender-identity mutations. SPF/DKIM can pass for an
  // unrelated envelope/signing domain while the visible From is forged.
  const senderAuthenticated = parsed.auth.dmarc === "pass";

  // Deduplicate by Message-ID within this inbox. The same RFC message can be
  // routed to two owned inboxes and both deliveries must remain visible.
  // Cancellation is replayed before returning: the original ingest may have
  // committed and then crashed while cancelling the sender's sequence.
  if (parsed.messageId) {
    const existing = await db
      .select({
        id: emails.id,
        personId: emails.personId,
        recipient: emails.recipient,
        personEmail: people.email,
      })
      .from(emails)
      .innerJoin(people, eq(people.id, emails.personId))
      .where(
        and(
          eq(emails.messageId, parsed.messageId),
          eq(emails.recipient, recipientCanonical),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      if (
        senderAuthenticated &&
        existing[0].recipient.trim().toLowerCase() === recipientCanonical &&
        existing[0].personEmail.trim().toLowerCase() === fromAddressCanonical
      ) {
        await cancelSequencesForPerson(db, existing[0].personId);
      }
      console.log(`Duplicate email with Message-ID: ${parsed.messageId}`);
      return;
    }
  }

  // Drop new mail from blocked senders/domains before storage or side effects.
  if (await isBlocked(db, fromAddressCanonical)) {
    console.log(`Dropped blocked email from ${fromAddressCanonical}`);
    return;
  }

  const rawHeadersJson = JSON.stringify(parsed.headers);
  const ccJson = parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null;
  if (
    !fitsD1EmailTextBudget(
      parsed.subject,
      parsed.bodyHtml,
      parsed.bodyText,
      rawHeadersJson,
      parsed.messageId,
      ccJson,
      recipientCanonical,
      fromAddressCanonical,
    )
  ) {
    message.setReject("Message content too large");
    return;
  }

  // Ensure the sender row exists without incrementing counters yet. The email
  // insert is the idempotency claim; counters and attachment metadata join it
  // in one D1 batch below so concurrent delivery of the same Message-ID cannot
  // increment twice or leave orphan D1 rows.
  const personId = nanoid();
  await db
    .insert(people)
    .values({
      id: personId,
      email: fromAddressCanonical,
      name: parsed.from.name || null,
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: people.email });

  // Get the actual person ID (could be existing). Lookup by the
  // canonical (lowercased) email so legacy mixed-case rows still
  // resolve to the same person.
  const personRow = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, fromAddressCanonical))
    .limit(1);
  const actualPersonId = personRow[0]!.id;

  // Prepare attachment ids first (needed for CID rewriting), but don't write
  // D1 metadata until the email's unique Message-ID claim succeeds.
  const cidMap: Record<string, string> = {};
  const emailId = nanoid();

  // Enforce attachment limits
  const cappedAttachments = parsed.attachments.slice(0, MAX_ATTACHMENTS);
  let totalAttachmentBytes = 0;
  const storedAttachments: Array<{
    id: string;
    emailId: string;
    kind: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    contentId: string | null;
    createdAt: number;
    content: ArrayBuffer;
  }> = [];

  for (const att of cappedAttachments) {
    totalAttachmentBytes += att.content.byteLength;
    if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.log(
        `Attachment size limit exceeded for email from ${parsed.from.address}, skipping remaining attachments`,
      );
      break;
    }

    const safeFilename = sanitizeFilename(att.filename);
    const attachmentId = nanoid();
    const r2Key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;

    const isInline = att.disposition === "inline" && !!att.contentId;
    storedAttachments.push({
      id: attachmentId,
      emailId,
      kind: "inbound",
      filename: safeFilename,
      contentType: att.contentType,
      size: att.content.byteLength,
      r2Key,
      contentId: isInline ? att.contentId : null,
      createdAt: now,
      content: att.content,
    });

    if (isInline && att.contentId) {
      const cleanCid = att.contentId.replace(/^<|>$/g, "");
      cidMap[cleanCid] = attachmentId;
    }
  }

  // Rewrite CID references in HTML body
  let bodyHtml = parsed.bodyHtml;
  if (bodyHtml && Object.keys(cidMap).length > 0) {
    for (const [cid, attachmentId] of Object.entries(cidMap)) {
      bodyHtml = bodyHtml.replace(
        new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
        `/api/attachments/${attachmentId}/inline`,
      );
    }
  }

  // A short cid: token may occur thousands of times and expand to the much
  // longer authenticated attachment URL. Re-check the exact post-rewrite body
  // before any R2/D1 side effect so expansion cannot overflow a D1 row or turn
  // delivery retries into a resource-exhaustion loop.
  if (
    !fitsD1EmailTextBudget(
      parsed.subject,
      bodyHtml,
      parsed.bodyText,
      rawHeadersJson,
      parsed.messageId,
      ccJson,
      recipientCanonical,
      fromAddressCanonical,
    )
  ) {
    message.setReject("Message content too large");
    return;
  }

  // Compute the conversation_id, if this is a multi-participant thread.
  // External participants = the sender + everyone on the Cc line, minus
  // any addresses that match one of our sender_identities (those are
  // "internal" team members and don't change the group identity).
  //
  // One scan of sender_identities serves three consumers: the "our domains"
  // set below, the forward destination for this inbox, and the known-inbox
  // loop guard in `forwardInbound`.
  const identityRows = await db
    .select({
      email: senderIdentities.email,
      displayName: senderIdentities.displayName,
      forwardTo: senderIdentities.forwardTo,
    })
    .from(senderIdentities);

  const ourDomains = Array.from(
    new Set(
      identityRows
        .map((r) => {
          const at = r.email.lastIndexOf("@");
          return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  );
  const allParticipants = [
    fromAddressCanonical,
    ...parsed.cc.map((c) => c.email),
  ];
  const externals = externalsOnly(allParticipants, ourDomains);
  const conversationId = await computeConversationId(
    recipientCanonical,
    externals,
  );

  // R2 isn't part of a D1 transaction. Upload the immutable objects first,
  // then atomically claim the Message-ID + insert metadata + increment the
  // sender counters. A losing concurrent delivery deletes only its own
  // randomly-keyed objects. A committed batch never points at a half-written
  // attachment set.
  const uploadedKeys: string[] = [];
  try {
    for (const att of storedAttachments) {
      await env.R2.put(att.r2Key, att.content, {
        httpMetadata: { contentType: att.contentType },
      });
      uploadedKeys.push(att.r2Key);
    }
  } catch (err) {
    await Promise.allSettled(uploadedKeys.map((key) => env.R2.delete(key)));
    throw err;
  }

  const emailInsert = db.insert(emails).values({
    id: emailId,
    personId: actualPersonId,
    recipient: recipientCanonical,
    subject: parsed.subject,
    bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: rawHeadersJson,
    messageId: parsed.messageId,
    spf: parsed.auth.spf,
    dkim: parsed.auth.dkim,
    dmarc: parsed.auth.dmarc,
    spamScore: parsed.spamScore,
    isRead: 0,
    cc: ccJson,
    conversationId,
    receivedAt: now,
    createdAt: now,
  });
  const attachmentInserts = storedAttachments.map(({ content: _, ...att }) =>
    db.insert(attachments).values(att),
  );
  const personUpdate = db
    .update(people)
    .set({
      ...(senderAuthenticated
        ? { name: sql`COALESCE(${parsed.from.name || null}, ${people.name})` }
        : {}),
      lastEmailAt: now,
      unreadCount: sql`${people.unreadCount} + 1`,
      totalCount: sql`${people.totalCount} + 1`,
      updatedAt: now,
    })
    .where(eq(people.id, actualPersonId));

  try {
    await db.batch([emailInsert, ...attachmentInserts, personUpdate] as any);
  } catch (err) {
    // First detect an ambiguous-success response by this batch's primary key.
    // This works even for messages without a Message-ID. If our id is present,
    // deleting R2 would corrupt a transaction that actually committed.
    const ownRow = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.id, emailId))
      .limit(1);
    if (ownRow.length > 0) {
      // The batch committed; only the response was lost.
    } else if (parsed.messageId) {
      // Otherwise distinguish a concurrent Message-ID winner from an
      // unrelated D1 error.
      const winner = await db
        .select({
          id: emails.id,
          personId: emails.personId,
          recipient: emails.recipient,
          personEmail: people.email,
        })
        .from(emails)
        .innerJoin(people, eq(people.id, emails.personId))
        .where(
          and(
            eq(emails.messageId, parsed.messageId),
            eq(emails.recipient, recipientCanonical),
          ),
        )
        .limit(1);
      await Promise.allSettled(uploadedKeys.map((key) => env.R2.delete(key)));
      if (winner.length > 0) {
        if (
          senderAuthenticated &&
          winner[0].recipient.trim().toLowerCase() === recipientCanonical &&
          winner[0].personEmail.trim().toLowerCase() === fromAddressCanonical
        ) {
          await cancelSequencesForPerson(db, winner[0].personId);
        }
        console.log(`Duplicate email with Message-ID: ${parsed.messageId}`);
        return;
      }
      throw err;
    } else {
      await Promise.allSettled(uploadedKeys.map((key) => env.R2.delete(key)));
      throw err;
    }
  }

  // Notify connected WebSocket clients about the new email (per-user DOs).
  // Fan out to users with explicit permission for this inbox, plus admins
  // (capped) — all best-effort via ctx.waitUntil so push failures never
  // block the inbound-email path.
  ctx.waitUntil(
    (async () => {
      try {
        const activeUser = or(
          isNull(users.banned),
          eq(users.banned, false),
          and(
            eq(users.banned, true),
            isNotNull(users.banExpires),
            lte(users.banExpires, new Date()),
          ),
        );
        const [permRows, adminRows] = await Promise.all([
          db
            .select({ userId: inboxPermissions.userId })
            .from(inboxPermissions)
            .innerJoin(users, eq(users.id, inboxPermissions.userId))
            .where(
              and(eq(inboxPermissions.email, recipientCanonical), activeUser),
            )
            .limit(MAX_TOTAL_FANOUT + 1),
          db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, "admin"), activeUser))
            .limit(MAX_TOTAL_FANOUT + 1),
        ]);
        const { userIds, adminTruncated, permissionTruncated } =
          computeFanoutTargets({
            permissionUserIds: permRows.map((r) => r.userId),
            adminUserIds: adminRows.map((r) => r.id),
          });
        if (adminTruncated) {
          console.warn(
            `Admin count exceeds notification fanout cap (${MAX_ADMIN_FANOUT}); truncating.`,
          );
        }
        if (permissionTruncated) {
          console.warn(
            `Inbox permission count exceeds total notification fanout cap (${MAX_TOTAL_FANOUT}); truncating.`,
          );
        }
        const deliverPayload = JSON.stringify({
          inbox: recipientCanonical,
          threadId: actualPersonId,
          personId: actualPersonId,
          senderName: parsed.from.name || fromAddressCanonical,
          subject: parsed.subject ?? "",
          bodyPreview: (parsed.bodyText ?? "").slice(0, 140),
        });
        const results = await Promise.allSettled(
          userIds.map((userId) => {
            const hub = env.NOTIFICATIONS_HUB.get(
              env.NOTIFICATIONS_HUB.idFromName(userId),
            );
            return hub.fetch(
              new Request("http://do/deliver", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: deliverPayload,
              }),
            );
          }),
        );
        const failures = results.filter((r) => r.status === "rejected").length;
        if (failures > 0) {
          console.warn(
            `Real-time fanout: ${failures}/${results.length} DO notifies failed`,
          );
        }
      } catch (err) {
        // Non-fatal: real-time push is best-effort.
        console.warn("Real-time fanout error:", err);
      }
    })(),
  );

  // Best-effort outbound webhook for external automation (n8n / Make / etc.).
  // No-op unless an admin has configured a destination URL. Mirrors the push
  // fan-out: fire-and-forget via ctx.waitUntil so a slow/failing receiver
  // never blocks ingestion. One event per received message (after dedupe).
  deliverWebhook(
    db,
    ctx,
    buildWebhookPayload({
      emailId,
      receivedAt: now,
      inbox: recipientCanonical,
      fromAddress: parsed.from.address,
      fromName: parsed.from.name || null,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      conversationId,
      attachments: storedAttachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
      auth: parsed.auth,
      baseUrl: env.BASE_URL,
    }),
  );

  // Per-inbox forwarding ("redirect rule"). Re-sends this message to the
  // inbox's configured destination through the outbound provider, because
  // Cloudflare Email Routing's own forwarding rules relay from IPs that Outlook
  // blocklists (550 5.7.1 S3150). See lib/inbound-forward.ts for the full
  // rationale. Best-effort and non-blocking, like the webhook above — and it
  // sits after the blocklist and dedupe gates, so blocked senders and duplicate
  // deliveries are never forwarded.
  const inboxIdentity = identityRows.find(
    (r) => r.email.trim().toLowerCase() === recipientCanonical,
  );
  forwardInbound(env, ctx, {
    inbox: recipientCanonical,
    forwardTo: inboxIdentity?.forwardTo ?? null,
    inboxDisplayName: inboxIdentity?.displayName ?? null,
    from: parsed.from,
    subject: parsed.subject,
    fullBodyHtml: parsed.fullBodyHtml,
    fullBodyText: parsed.fullBodyText,
    messageId: parsed.messageId,
    receivedAt: now,
    cc: parsed.cc,
    auth: parsed.auth,
    attachments: cappedAttachments,
    headers: parsed.headers,
    knownInboxes: identityRows.map((r) => r.email),
  });

  // Receiving/storing untrusted mail is safe; mutating the sender's automation
  // is not. A forged visible From must never cancel another contact's drip.
  if (senderAuthenticated) {
    await cancelSequencesForPerson(db, actualPersonId);
  }

  console.log(
    `Processed email from ${fromAddressCanonical} to ${recipientCanonical} (${parsed.attachments.length} attachments)`,
  );
}
