import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { cancelSequencesForPerson } from "./cancel-sequence";
import { hashKey } from "./crypto";
import { fitsD1EmailTextBudget } from "./email-limits";
import type { ParsedEmail } from "./email-parser";
import { createEmailSender } from "./email-sender";
import { sanitizeHeaderValue } from "./format-from-address";
import { escapeHtml } from "./interpolate";
import { MAX_ATTACHMENTS } from "./multipart-send";
import { attemptOutboxRow } from "./outbox";
import { surfaceReplyTo } from "./queries/emails";
import { sanitizeFilename } from "./sanitize-filename";

/** 60-byte local part: nanoid + a 128-bit MAC, bound to the current destination. */
export async function forwardReplyAddress(
  emailId: string,
  inbox: string,
  forwardTo: string,
  secret: string,
): Promise<string> {
  if (!secret || !/^[\w-]{21}$/.test(emailId)) {
    throw new Error(
      "Forward reply requires a signing secret and stored email id",
    );
  }
  const canonicalInbox = inbox.trim().toLowerCase();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify([
        "forward-reply-v1",
        emailId,
        canonicalInbox,
        forwardTo.trim().toLowerCase(),
      ]),
    ),
  );
  const signature = Array.from(new Uint8Array(mac).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `reply+${emailId}.${signature}@${canonicalInbox.split("@")[1]}`;
}

/** Intercept reserved reply aliases before ordinary inbound ingestion/forwarding. */
export async function handleForwardReply(
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  message: ForwardableEmailMessage,
  parsed: ParsedEmail,
): Promise<boolean> {
  if (!/^reply\+/i.test(message.to)) return false;
  const reject = (reason: string) => {
    message.setReject(reason);
    return true;
  };
  const match = /^reply\+([\w-]{21})\.([a-f0-9]{32})@([a-z0-9.-]+)$/i.exec(
    message.to,
  );
  if (!match) return reject("Invalid forwarded reply address");
  const [original] = await db
    .select({
      email: emails,
      identity: senderIdentities,
      personEmail: people.email,
    })
    .from(emails)
    .innerJoin(senderIdentities, eq(senderIdentities.email, emails.recipient))
    .innerJoin(people, eq(people.id, emails.personId))
    .where(eq(emails.id, match[1]))
    .limit(1);
  if (!original?.identity.forwardTo || !env.BETTER_AUTH_SECRET) {
    return reject("Forwarded reply is no longer available");
  }
  const { email, identity, personEmail } = original;
  const personal = identity.forwardTo.trim().toLowerCase();
  const expected = await forwardReplyAddress(
    email.id,
    identity.email,
    personal,
    env.BETTER_AUTH_SECRET,
  );
  const actual = `reply+${match[1]}.${match[2].toLowerCase()}@${match[3].toLowerCase()}`;
  // Workers exposes this native extension; keep its type local to the relay.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  if (
    actual.length !== expected.length ||
    !subtle.timingSafeEqual(
      new TextEncoder().encode(actual),
      new TextEncoder().encode(expected),
    ) ||
    parsed.auth.dmarc !== "pass" ||
    parsed.from.address.trim().toLowerCase() !== personal ||
    message.from.trim().toLowerCase() !== personal
  ) {
    return reject("Forwarded reply sender or signature is invalid");
  }
  if (
    (parsed.headers["auto-submitted"] &&
      parsed.headers["auto-submitted"].toLowerCase() !== "no") ||
    /^(bulk|junk|list)$/i.test(parsed.headers.precedence ?? "") ||
    ["x-autoreply", "x-autorespond", "x-saasmail-forwarded-for"].some(
      (key) => key in parsed.headers,
    )
  ) {
    return reject("Automatic replies cannot be relayed");
  }
  if (!parsed.messageId)
    return reject("A Message-ID is required for forwarded replies");

  // Use only the stored conversation to select recipients. Personal To/Cc/Reply-To
  // headers cannot turn this endpoint into an arbitrary sender or recipient relay.
  const toAddress =
    surfaceReplyTo(email.rawHeaders, personEmail) ?? personEmail;
  if (
    !/^[^\s<>"@,;]+@[^\s<>"@,;]+\.[^\s<>"@,;]+$/.test(toAddress) ||
    toAddress.toLowerCase() === personal ||
    toAddress.toLowerCase() === identity.email.toLowerCase() ||
    /^reply\+/i.test(toAddress)
  ) {
    return reject("Invalid recipient for forwarded reply");
  }
  const sender = createEmailSender(env);
  const id = `forward-reply-${await hashKey(JSON.stringify([email.id, personal, parsed.messageId]))}`;
  const deliver = () =>
    ctx.waitUntil(
      attemptOutboxRow(db, env, sender, id).catch((error) => {
        console.error("Forwarded reply outbox attempt failed:", id, error);
      }),
    );
  const existing = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);
  if (existing.length > 0) {
    deliver();
    return true;
  }

  const bodyText = parsed.bodyText?.trim() || null;
  const bodyHtml =
    parsed.bodyHtml?.trim() ||
    (bodyText
      ? `<pre style="white-space:pre-wrap">${escapeHtml(bodyText)}</pre>`
      : null);
  if (!bodyHtml && parsed.attachments.length === 0)
    return reject("Forwarded reply is empty");
  if (
    parsed.attachments.length > MAX_ATTACHMENTS ||
    parsed.attachments.reduce(
      (total, file) => total + file.content.byteLength,
      0,
    ) > sender.maxAttachmentBytes()
  ) {
    return reject("Forwarded reply attachments exceed the sending limit");
  }
  const subject = sanitizeHeaderValue(
    /^re:/i.test(email.subject ?? "")
      ? email.subject!
      : `Re: ${email.subject ?? ""}`,
  );
  const messageId = `<${id}@${identity.email.split("@")[1]}>`;
  const headers = {
    "Message-ID": messageId,
    "Reply-To": identity.email,
    ...(email.messageId
      ? {
          "In-Reply-To": sanitizeHeaderValue(email.messageId),
          References: sanitizeHeaderValue(email.messageId),
        }
      : {}),
  };
  if (
    !fitsD1EmailTextBudget(
      identity.email,
      toAddress,
      subject,
      bodyHtml,
      bodyText,
      JSON.stringify(headers),
    )
  ) {
    return reject("Forwarded reply content exceeds the storage limit");
  }
  await cancelSequencesForPerson(db, email.personId);
  const now = Math.floor(Date.now() / 1000);
  const files = parsed.attachments.map((file) => {
    const attachmentId = nanoid();
    const filename = sanitizeFilename(file.filename);
    return {
      id: attachmentId,
      emailId: id,
      kind: "sent",
      filename,
      contentType: file.contentType,
      size: file.content.byteLength,
      r2Key: `attachments/sent/${id}/${attachmentId}/${filename}`,
      contentId: null,
      createdAt: now,
      content: file.content,
    };
  });
  const uploaded: string[] = [];
  try {
    for (const file of files) {
      await env.R2.put(file.r2Key, file.content, {
        httpMetadata: { contentType: file.contentType },
      });
      uploaded.push(file.r2Key);
    }
    // The primary key is the replay/concurrency fence. History, retry material
    // and attachment metadata commit together, before any provider is called.
    await db.batch([
      db.insert(sentEmails).values({
        id,
        personId: email.personId,
        fromAddress: identity.email,
        toAddress,
        subject,
        bodyHtml,
        bodyText,
        messageId,
        inReplyTo: email.messageId,
        conversationId: email.conversationId,
        status: "retrying",
        sentAt: now,
        createdAt: now,
      }),
      db.insert(outboxEmails).values({
        id,
        sentEmailId: id,
        fromAddress: identity.email,
        toAddress,
        subject,
        bodyHtml,
        bodyText,
        headers: JSON.stringify(headers),
        transactional: 1,
        status: "pending",
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      ...files.map(({ content: _, ...file }) =>
        db.insert(attachments).values(file),
      ),
    ]);
  } catch (error) {
    // A concurrent delivery or a lost D1 response may already have committed.
    // Delete only this attempt's unreferenced R2 objects, never the winner's.
    const committed = await db
      .select({ id: sentEmails.id })
      .from(sentEmails)
      .where(eq(sentEmails.id, id))
      .limit(1);
    const stored = await db
      .select({ r2Key: attachments.r2Key })
      .from(attachments)
      .where(eq(attachments.emailId, id));
    const keep = new Set(stored.map((file) => file.r2Key));
    await Promise.allSettled(
      uploaded.filter((key) => !keep.has(key)).map((key) => env.R2.delete(key)),
    );
    if (committed.length === 0) throw error;
  }
  deliver();
  return true;
}
