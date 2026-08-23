import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { cancelSequencesForPerson } from "./cancel-sequence";
import { computeConversationId, externalsOnly } from "./conversation-id";
import { createEmailSender } from "./email-sender";
import {
  EMAIL_CONTENT_TOO_LARGE_MESSAGE,
  fitsD1EmailTextBudget,
} from "./email-limits";
import { formatFromAddress, sanitizeHeaderValue } from "./format-from-address";
import { proximoHorarioComercial } from "./horario-comercial";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { renderTemplate, type TemplateVariables } from "./interpolate";
import { generateMessageId } from "./message-id";
import type { ParsedFile } from "./multipart-send";
import {
  finalizeSuccessfulOutbox,
  sendViaOutbox,
  type OutboxOutcome,
} from "./outbox";
import { canReadTemplate } from "./template-access";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

async function cancelSequencesForEmails(
  db: Db,
  addresses: readonly string[],
): Promise<void> {
  const canonical = Array.from(
    new Set(addresses.map((address) => address.trim().toLowerCase())),
  ).filter(Boolean);
  if (canonical.length === 0) return;
  const recipients = await db
    .select({ id: people.id })
    .from(people)
    .where(inArray(people.email, canonical));
  for (const recipient of recipients) {
    await cancelSequencesForPerson(db, recipient.id);
  }
}

export type SendCcEntry = {
  email: string;
  name?: string | null;
};

export type SendEmailPayload = {
  to: string;
  fromAddress: string;
  cc?: SendCcEntry[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  replyTo?: string;
  transactional?: boolean;
  /** Grava no outbox para o proximo slot de horario comercial em vez de enviar agora.
   *  O instante e' calculado no servidor — ver lib/horario-comercial. */
  agendarHorarioComercial?: boolean;
};

export type SendEmailParams = {
  db: Db;
  env: CloudflareBindings;
  payload: SendEmailPayload;
  files: ParsedFile[];
  allowed: AllowedInboxes;
};

export type SendEmailSuccess = {
  ok: true;
  id: string | null;
  resendId: string | null;
  status: OutboxOutcome;
  attachmentIds: string[];
  delivered: string[];
  suppressed: string[];
  /** Epoch segundos, so' quando `status === "scheduled"`. A tela confirma a hora com o
   *  numero que o SERVIDOR calculou, e nao com uma conta propria — duas implementacoes
   *  do mesmo calendario divergem, e a que o usuario ve seria a errada. */
  scheduledFor?: number;
};

// The compose path has no recoverable failure mode of its own: multipart
// parse errors are handled before this runs, and a disallowed inbox throws
// (HTTPException). Kept as a discriminated union so callers branch on `ok`
// the same way they do for replies.
export type SendEmailResult =
  | SendEmailSuccess
  | {
      ok: false;
      code: "CONTENT_TOO_LARGE";
      message: string;
    };

export type ReplyEmailPayload = {
  fromAddress: string;
  bodyHtml?: string;
  bodyText?: string;
  cc?: SendCcEntry[];
  templateSlug?: string;
  variables?: TemplateVariables;
  replyTo?: string;
  /** Grava no outbox para o proximo slot de horario comercial em vez de enviar agora.
   *  O instante e' calculado no servidor — ver lib/horario-comercial. */
  agendarHorarioComercial?: boolean;
};

export type ReplyEmailParams = {
  db: Db;
  env: CloudflareBindings;
  emailId: string;
  payload: ReplyEmailPayload;
  files: ParsedFile[];
  allowed: AllowedInboxes;
};

export type ReplyEmailSuccess = {
  ok: true;
  id: string;
  resendId: string | null;
  status: OutboxOutcome;
  attachmentIds: string[];
};

export type ReplyEmailFailure =
  | {
      ok: false;
      code:
        | "PERSON_NOT_FOUND"
        | "EMAIL_NOT_FOUND"
        | "EMAIL_HAS_NO_PERSON"
        | "TEMPLATE_NOT_FOUND"
        | "MISSING_BODY"
        | "TEMPLATE_PARSE_ERROR"
        | "CONTENT_TOO_LARGE";
      message: string;
    }
  | {
      ok: false;
      code: "MISSING_VARIABLES";
      message: string;
      missingVariables: string[];
      requiredVariables: string[];
    };

export type ReplyEmailResult = ReplyEmailSuccess | ReplyEmailFailure;

/**
 * Fetch the set of "internal" domains (domains owned by our
 * sender_identities) for the current request — used to derive the
 * external-only participant list when computing a conversation_id.
 */
async function fetchInternalDomains(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return Array.from(
    new Set(
      rows
        .map((r: { email: string }) => {
          const at = r.email.lastIndexOf("@");
          return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  ) as string[];
}

async function persistSentAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
  files: ParsedFile[],
  now: number,
): Promise<string[]> {
  if (files.length === 0) return [];
  const rows = files.map((f) => {
    const attachmentId = nanoid();
    const r2Key = `attachments/sent/${sentEmailId}/${attachmentId}/${f.filename}`;
    return { attachmentId, r2Key, file: f };
  });
  const uploadedKeys: string[] = [];
  try {
    for (const row of rows) {
      await env.R2.put(row.r2Key, row.file.bytes, {
        httpMetadata: { contentType: row.file.contentType },
      });
      uploadedKeys.push(row.r2Key);
    }
  } catch (err) {
    await Promise.allSettled(uploadedKeys.map((key) => env.R2.delete(key)));
    throw err;
  }

  const values = rows.map((r) => ({
    id: r.attachmentId,
    emailId: sentEmailId,
    kind: "sent" as const,
    filename: r.file.filename,
    contentType: r.file.contentType,
    size: r.file.size,
    r2Key: r.r2Key,
    contentId: null,
    createdAt: now,
  }));
  try {
    // D1 allows only 100 bound parameters per statement. A single 50-row
    // insert binds roughly 450 values, so keep each row as its own statement
    // inside one transactional batch.
    await db.batch(
      values.map((value) => db.insert(attachments).values(value)) as any,
    );
  } catch (err) {
    // A lost D1 response can look like a failed insert even though the single
    // multi-row statement committed. Preserve R2 when all generated ids are
    // present; otherwise clean up this attempt's immutable objects.
    const committed = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        inArray(
          attachments.id,
          rows.map((row) => row.attachmentId),
        ),
      );
    if (committed.length !== rows.length) {
      await Promise.allSettled(uploadedKeys.map((key) => env.R2.delete(key)));
      await db.delete(attachments).where(
        inArray(
          attachments.id,
          rows.map((row) => row.attachmentId),
        ),
      );
      throw err;
    }
  }
  return rows.map((r) => r.attachmentId);
}

/**
 * A thrown provider call can be an ambiguous acceptance. Preserve retry
 * material whenever its write-ahead row exists; deleting R2 in that case
 * would make the retry send a materially different message.
 */
async function deleteSentAttachmentsIfUnqueued(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<void> {
  try {
    const queued = await db
      .select({ id: outboxEmails.id })
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, sentEmailId))
      .limit(1);
    if (queued.length > 0) return;
  } catch {
    // On an ambiguous D1 read, preserving immutable objects is safer than
    // corrupting a possibly committed outbox row.
    return;
  }
  await deleteSentAttachments(db, env, sentEmailId);
}

async function deleteSentAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<void> {
  const rows = await db
    .select({ id: attachments.id, r2Key: attachments.r2Key })
    .from(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
  await Promise.allSettled(rows.map((row) => env.R2.delete(row.r2Key)));
  await db
    .delete(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
}

/**
 * Compose and send a new email, persisting attachments and the sent_emails
 * row. Callers own multipart parsing and hand over the already-parsed
 * payload plus attachment bytes.
 *
 * Only the inbox permission check throws (HTTPException), matching the
 * routers' existing behavior.
 */
export async function sendEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const { db, env, payload: raw, files, allowed } = params;
  const sender = createEmailSender(env);

  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const to = raw.to.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const subject = sanitizeHeaderValue(raw.subject);
  const { bodyHtml, bodyText, transactional } = raw;
  const replyTo = raw.replyTo?.trim().toLowerCase();
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  const messageId = generateMessageId(fromAddress);
  const headers = {
    "Message-ID": messageId,
    ...(replyTo ? { "Reply-To": replyTo } : {}),
  };
  if (
    !fitsD1EmailTextBudget(
      fromAddress,
      to,
      cc && cc.length > 0 ? JSON.stringify(cc) : null,
      subject,
      bodyHtml,
      bodyText,
      JSON.stringify(headers),
    )
  ) {
    return {
      ok: false,
      code: "CONTENT_TOO_LARGE",
      message: EMAIL_CONTENT_TOO_LARGE_MESSAGE,
    };
  }
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const internalDomains = await fetchInternalDomains(db);
  // A direct/manual attempt supersedes an active drip. Cancel before the
  // durable outbox/provider boundary so a Worker crash after acceptance can
  // never leave the automated sequence running alongside the manual message.
  await cancelSequencesForEmails(
    db,
    externalsOnly(
      [to, ...(cc ?? []).map((recipient) => recipient.email)],
      internalDomains,
    ),
  );

  const attachmentList =
    files.length > 0
      ? files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          content: f.bytes,
        }))
      : undefined;

  const id = nanoid();
  // Persist retry material before the first provider attempt. If the inline
  // call is transient, the outbox processor can immediately reload every
  // attachment instead of retrying a stripped-down message.
  const attachmentIds = await persistSentAttachments(db, env, id, files, now);
  // Agendar e' decidido AQUI, no servidor, e nao aceita instante vindo do cliente: um
  // horario do browser poderia cair de madrugada, no passado, ou em minuto quebrado (o
  // cron e' horario) — os tres viram entrega errada sem erro nenhum.
  const agendadoPara = raw.agendarHorarioComercial
    ? proximoHorarioComercial(Date.now())
    : undefined;
  let outboxResult: Awaited<ReturnType<typeof sendViaOutbox>>;
  try {
    outboxResult = await sendViaOutbox({
      db,
      env,
      sender,
      sentEmailId: id,
      fromAddress,
      from: formattedFrom,
      to,
      cc,
      subject,
      html: bodyHtml,
      text: bodyText,
      headers,
      attachments: attachmentList,
      transactional,
      agendadoPara,
    });
  } catch (err) {
    await deleteSentAttachmentsIfUnqueued(db, env, id);
    throw err;
  }
  const { outcome, send: sendResult } = outboxResult;

  // Every recipient was suppressed — no send happened. The matching drips
  // were already cancelled before the outbox/provider boundary above.
  if (outcome === "suppressed") {
    await deleteSentAttachments(db, env, id);

    console.log(
      "[send] all recipients suppressed",
      JSON.stringify({ from: fromAddress, suppressed: sendResult.suppressed }),
    );
    return {
      ok: true,
      id: null,
      resendId: null,
      status: "suppressed",
      attachmentIds: [],
      delivered: [],
      suppressed: sendResult.suppressed,
    };
  }

  // The transport was called; reflect its result in sent_emails.
  // When the primary `to` was suppressed, the helper promoted a surviving cc
  // to be the actual primary recipient. Use that for audit + person lookup so
  // the row reflects who actually got the email.
  const recordedTo = sendResult.delivered[0] ?? sendResult.attempted?.[0] ?? to;

  // Find or create the person row for the actual recipient.
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, recordedTo))
    .limit(1);

  let personId: string;
  if (existingPerson[0]) {
    personId = existingPerson[0].id;
  } else {
    personId = nanoid();
    await db
      .insert(people)
      .values({
        id: personId,
        email: recordedTo,
        name: null,
        lastEmailAt: now,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: people.email });
    const refetched = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, recordedTo))
      .limit(1);
    personId = refetched[0]!.id;
  }

  const externals = externalsOnly(
    [recordedTo, ...(cc ?? []).map((c) => c.email)],
    internalDomains,
  );
  const conversationId = await computeConversationId(fromAddress, externals);

  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: recordedTo,
    subject,
    bodyHtml: sendResult.renderedHtml ?? bodyHtml,
    bodyText: sendResult.renderedText ?? bodyText ?? null,
    messageId,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    ...(agendadoPara != null ? { scheduledFor: agendadoPara } : {}),
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId,
    sentAt: now,
    createdAt: now,
  });

  if (outcome === "sent" || outcome === "failed") {
    await finalizeSuccessfulOutbox(db, id);
  }

  return {
    ok: true,
    id,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    ...(agendadoPara != null ? { scheduledFor: agendadoPara } : {}),
    attachmentIds,
    delivered: sendResult.delivered,
    suppressed: sendResult.suppressed,
  };
}

/**
 * Reply to an existing email — resolved across both the received and sent
 * tables — threading the reply via In-Reply-To.
 *
 * Failure modes callers must surface are returned rather than thrown so this
 * can back both the HTTP route and the MCP tool; only the inbox permission
 * check throws (HTTPException), matching the routers' existing behavior.
 */
export async function replyToEmail(
  params: ReplyEmailParams,
): Promise<ReplyEmailResult> {
  const { db, env, emailId, payload: raw, files, allowed } = params;
  const sender = createEmailSender(env);

  // Same canonicalization story as the send route — lowercase the
  // inbox + recipient + CC emails before downstream use so stored
  // rows match the lowercased conversation_id.
  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { bodyHtml, bodyText, templateSlug, variables } = raw;
  const replyTo = raw.replyTo?.trim().toLowerCase();
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  // Resolve the original across both received and sent tables.
  const receivedRow = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  let origPersonId: string;
  let origSubject: string | null;
  let origInReplyToMessageId: string | null;
  let toAddress: string;

  if (receivedRow.length > 0) {
    const orig = receivedRow[0];
    // Mirror of the sent-row check below: only allow replies to messages
    // delivered to an inbox the caller still owns. Without this a scoped user
    // could thread a reply into a conversation they cannot read.
    assertInboxAllowed(allowed, orig.recipient);
    const person = await db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, orig.personId))
      .limit(1);
    if (person.length === 0) {
      return {
        ok: false,
        code: "PERSON_NOT_FOUND",
        message: "Person not found",
      };
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    // Canonicalize the recipient — older rows may be mixed-case.
    toAddress = person[0].email.toLowerCase();
  } else {
    const sentRow = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, emailId))
      .limit(1);
    if (sentRow.length === 0) {
      return { ok: false, code: "EMAIL_NOT_FOUND", message: "Email not found" };
    }
    const orig = sentRow[0];
    // Defense-in-depth: only allow replies to sent rows whose original
    // fromAddress the caller still owns. Prevents a user from threading a
    // reply to another user's outgoing message via its id.
    assertInboxAllowed(allowed, orig.fromAddress);
    if (!orig.personId) {
      return {
        ok: false,
        code: "EMAIL_HAS_NO_PERSON",
        message: "Email has no associated person",
      };
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    toAddress = orig.toAddress.toLowerCase();
  }

  // Determine subject and body
  let finalSubject: string;
  let finalBodyHtml: string;

  if (templateSlug) {
    // Template-based reply
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, templateSlug))
      .limit(1);

    if (templateRows.length === 0) {
      return {
        ok: false,
        code: "TEMPLATE_NOT_FOUND",
        message: "Template not found",
      };
    }

    if (!canReadTemplate(allowed, templateRows[0].fromAddress)) {
      return {
        ok: false,
        code: "TEMPLATE_NOT_FOUND",
        message: "Template not found",
      };
    }

    const rendered = renderTemplate(templateRows[0], variables ?? {});
    if (!rendered.ok) {
      if (rendered.parseError) {
        return {
          ok: false,
          code: "TEMPLATE_PARSE_ERROR",
          message: rendered.parseError,
        };
      }
      return {
        ok: false,
        code: "MISSING_VARIABLES",
        message: "Missing required template variables",
        missingVariables: rendered.missingVariables,
        requiredVariables: rendered.requiredVariables,
      };
    }

    finalSubject = sanitizeHeaderValue(rendered.subject);
    finalBodyHtml = rendered.bodyHtml;
  } else if (bodyHtml) {
    // Freeform reply
    finalSubject = sanitizeHeaderValue(
      origSubject?.startsWith("Re: ")
        ? origSubject
        : `Re: ${origSubject || ""}`,
    );
    finalBodyHtml = bodyHtml;
  } else {
    return {
      ok: false,
      code: "MISSING_BODY",
      message: "Either bodyHtml or templateSlug is required",
    };
  }

  const messageId = generateMessageId(fromAddress);
  const headers = {
    "Message-ID": messageId,
    ...(origInReplyToMessageId
      ? { "In-Reply-To": origInReplyToMessageId }
      : {}),
    ...(replyTo ? { "Reply-To": replyTo } : {}),
  };
  if (
    !fitsD1EmailTextBudget(
      fromAddress,
      toAddress,
      cc && cc.length > 0 ? JSON.stringify(cc) : null,
      finalSubject,
      finalBodyHtml,
      bodyText,
      JSON.stringify(headers),
    )
  ) {
    return {
      ok: false,
      code: "CONTENT_TOO_LARGE",
      message: EMAIL_CONTENT_TOO_LARGE_MESSAGE,
    };
  }
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const internalDomainsReply = await fetchInternalDomains(db);
  const externalsReply = externalsOnly(
    [toAddress, ...(cc ?? []).map((recipient) => recipient.email)],
    internalDomainsReply,
  );
  const conversationIdReply = await computeConversationId(
    fromAddress,
    externalsReply,
  );
  // Fail closed before transport: a manual reply supersedes an existing drip
  // even if the provider later rejects or queues the attempt for retry.
  await cancelSequencesForEmails(db, externalsReply);
  await cancelSequencesForPerson(db, origPersonId);
  // Replies are 1:1 conversational responses to an inbound — the recipient
  // initiated by emailing first, so route through sendViaOutbox
  // with transactional: true. That bypasses the suppression list AND skips
  // the unsubscribe footer / List-Unsubscribe header (this is a reply, not
  // a bulk send).
  const id = nanoid();
  const attachmentIds = await persistSentAttachments(db, env, id, files, now);
  // Agendar e' decidido AQUI, no servidor, e nao aceita instante vindo do cliente: um
  // horario do browser poderia cair de madrugada, no passado, ou em minuto quebrado (o
  // cron e' horario) — os tres viram entrega errada sem erro nenhum.
  const agendadoPara = raw.agendarHorarioComercial
    ? proximoHorarioComercial(Date.now())
    : undefined;
  let outboxResult: Awaited<ReturnType<typeof sendViaOutbox>>;
  try {
    outboxResult = await sendViaOutbox({
      db,
      env,
      sender,
      sentEmailId: id,
      fromAddress,
      from: formattedFrom,
      to: toAddress,
      cc,
      subject: finalSubject,
      html: finalBodyHtml,
      ...(bodyText !== undefined ? { text: bodyText } : {}),
      headers,
      ...(files.length > 0
        ? {
            attachments: files.map((f) => ({
              filename: f.filename,
              contentType: f.contentType,
              content: f.bytes,
            })),
          }
        : {}),
      agendadoPara,
      transactional: true,
    });
  } catch (err) {
    await deleteSentAttachmentsIfUnqueued(db, env, id);
    throw err;
  }
  const { outcome, send: sendResult } = outboxResult;

  // Store sent email
  await db.insert(sentEmails).values({
    id,
    personId: origPersonId,
    fromAddress,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: origInReplyToMessageId,
    messageId,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    ...(agendadoPara != null ? { scheduledFor: agendadoPara } : {}),
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId: conversationIdReply,
    sentAt: now,
    createdAt: now,
  });

  if (outcome === "sent" || outcome === "failed") {
    await finalizeSuccessfulOutbox(db, id);
  }

  return {
    ok: true,
    id,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    ...(agendadoPara != null ? { scheduledFor: agendadoPara } : {}),
    attachmentIds,
  };
}
