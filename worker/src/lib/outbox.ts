import { nanoid } from "nanoid";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { schema } from "../db/schema";
import type { EmailSender, SendEmailAttachment } from "./email-sender";
import {
  createEmailSender,
  createEmailSenderForProvider,
} from "./email-sender";
import {
  sendWithSuppressionCheck,
  SendAbortedError,
  type CcRecipient,
  type SendOutput,
} from "./send";
import { formatFromAddress } from "./format-from-address";
import { isDemoMode } from "./is-dev";
import { completeEnrollmentIfDone } from "./enrollment-completion";
import { isSuppressed } from "./suppressions";
import { computeConversationId, externalsOnly } from "./conversation-id";
import {
  EmailContentTooLargeError,
  EMAIL_CONTENT_TOO_LARGE_MESSAGE,
  fitsD1EmailTextBudget,
} from "./email-limits";

/** Total provider attempts before a transient failure becomes terminal.
 *  With the hourly cron this is ~24h — enough to ride out Cloudflare's
 *  daily send-quota reset. */
export const MAX_OUTBOX_ATTEMPTS = 24;

/** Caps one cron tick's work; anything beyond drains on subsequent ticks. */
const OUTBOX_BATCH_LIMIT = 200;

export type OutboxOutcome = "sent" | "suppressed" | "retrying" | "failed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

async function concreteProviderForSend(
  db: Db,
  sender: EmailSender,
  fromAddress: string,
): Promise<EmailSender["provider"]> {
  if (sender.provider !== "routed") return sender.provider;
  const row = await db
    .select({ provider: senderIdentities.outboundProvider })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, fromAddress))
    .limit(1);
  return row[0]?.provider ?? "cloudflare";
}

function knownProvider(value: string | null): EmailSender["provider"] | null {
  return value === "resend" ||
    value === "cloudflare" ||
    value === "bavimail" ||
    value === "postmark" ||
    value === "demo"
    ? value
    : null;
}

function providerSupportsAutomaticAmbiguousRetry(
  provider: EmailSender["provider"],
): boolean {
  // Resend consumes the stable idempotency key. The other transports expose
  // no equivalent cross-request dedupe guarantee, so a lost response must be
  // held for manual review rather than automatically duplicated.
  return provider === "resend" || provider === "demo" || provider === "none";
}

function activeTransportStatus(
  provider: EmailSender["provider"],
): "pending" | "sending" {
  return providerSupportsAutomaticAmbiguousRetry(provider)
    ? "pending"
    : "sending";
}

async function beginProviderAttempt(
  db: Db,
  id: string,
  provider: EmailSender["provider"],
): Promise<void> {
  if (providerSupportsAutomaticAmbiguousRetry(provider)) return;
  const started = await db
    .update(outboxEmails)
    .set({ status: "sending", updatedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(outboxEmails.id, id), eq(outboxEmails.status, "pending")))
    .returning({ id: outboxEmails.id });
  if (started.length === 0) throw new SendAbortedError();
}

export interface OutboxSendParams {
  db: Db;
  env: CloudflareBindings;
  sender: EmailSender;
  /** Pre-generated id of the sent_emails row the caller will write. */
  sentEmailId: string;
  /** Set for sequence-step sends. */
  sequenceEmailId?: string | null;
  /** Bare lowercase inbox address (scoping key; re-formatted on retry). */
  fromAddress: string;
  /** Formatted "Name <addr>" for the wire. */
  from: string;
  to: string;
  cc?: CcRecipient[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
  transactional?: boolean;
  /** Last-moment ownership/cancellation fence immediately before transport. */
  beforeSend?: () => Promise<void>;
}

export interface OutboxSendResult {
  outcome: OutboxOutcome;
  send: SendOutput;
}

/**
 * Write-ahead send. Transactional mail is one provider unit (To + CC).
 * Marketing mail is one durable unit per recipient because each recipient
 * gets a distinct unsubscribe token. Keeping those units separate prevents a
 * partial provider success from duplicating already-accepted CC recipients on
 * retry or silently losing a later recipient's failure.
 */
export async function sendViaOutbox(
  params: OutboxSendParams,
): Promise<OutboxSendResult> {
  const {
    db,
    env,
    sender,
    sentEmailId,
    sequenceEmailId,
    fromAddress,
    from,
    to,
    cc,
    subject,
    html,
    text,
    headers,
    attachments,
    transactional,
    beforeSend,
  } = params;
  // Canonical callers already lowercase addresses, but reject duplicate
  // envelope recipients defensively (To repeated in Cc or duplicate Cc).
  const seenRecipients = new Set([to.trim().toLowerCase()]);
  const effectiveCc = (cc ?? []).filter((entry) => {
    const canonical = entry.email.trim().toLowerCase();
    if (seenRecipients.has(canonical)) return false;
    seenRecipients.add(canonical);
    return true;
  });
  if (
    !fitsD1EmailTextBudget(
      fromAddress,
      to,
      effectiveCc.length > 0 ? JSON.stringify(effectiveCc) : null,
      subject,
      html,
      text,
      headers ? JSON.stringify(headers) : null,
    )
  ) {
    throw new RangeError(EMAIL_CONTENT_TOO_LARGE_MESSAGE);
  }
  const now = Math.floor(Date.now() / 1000);
  const provider = await concreteProviderForSend(db, sender, fromAddress);
  const concreteSender =
    sender.provider === "routed"
      ? createEmailSenderForProvider(env, provider)
      : sender;
  type SendUnit = {
    id: string;
    email: string;
    name: string | null;
    cc?: CcRecipient[];
    visibleTo?: string;
    envelopeTo?: string;
  };
  const units: SendUnit[] =
    transactional === true &&
    provider === "cloudflare" &&
    effectiveCc.length > 0
      ? [
          { email: to, name: null },
          ...effectiveCc.map((entry) => ({
            email: entry.email,
            name: entry.name ?? null,
          })),
        ].map((recipient, index) => ({
          id: `${sentEmailId}:${String(index).padStart(3, "0")}:${nanoid(6)}`,
          email: recipient.email,
          name: recipient.name,
          visibleTo: to,
          envelopeTo: recipient.email,
          cc: effectiveCc,
        }))
      : transactional === true
        ? [
            {
              id: nanoid(),
              email: to,
              name: null,
              cc: effectiveCc.length > 0 ? effectiveCc : undefined,
            },
          ]
        : [
            {
              id: `${sentEmailId}:000:${nanoid(6)}`,
              email: to,
              name: null,
              cc: undefined,
            },
            ...effectiveCc.map((entry, index) => ({
              id: `${sentEmailId}:${String(index + 1).padStart(3, "0")}:${nanoid(6)}`,
              email: entry.email,
              name: entry.name ?? null,
              cc: undefined,
            })),
          ];

  // Create every unit before the first provider side effect. A hard crash in
  // the middle therefore leaves all not-yet-attempted recipients recoverable.
  await db.batch(
    units.map((unit) =>
      db.insert(outboxEmails).values({
        id: unit.id,
        sentEmailId,
        sequenceEmailId: sequenceEmailId ?? null,
        fromAddress,
        toAddress: unit.email,
        wireTo: unit.visibleTo ?? null,
        // New per-recipient marketing units keep the original aggregate CC
        // metadata for crash-history repair. Retries recognize the unit id and
        // do not put these addresses back on the wire.
        cc:
          transactional === true
            ? unit.cc && unit.cc.length > 0
              ? JSON.stringify(unit.cc)
              : null
            : effectiveCc.length > 0
              ? JSON.stringify(effectiveCc)
              : null,
        subject,
        bodyHtml: html ?? null,
        bodyText: text ?? null,
        headers: headers ? JSON.stringify(headers) : null,
        transactional: transactional === true ? 1 : 0,
        provider,
        status: "pending",
        attempts: 0,
        nextRetryAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      }),
    ) as any,
  );

  const delivered: string[] = [];
  const attempted: string[] = [];
  const suppressed: string[] = [];
  let firstSuccess: SendOutput | undefined;
  let firstTransient: SendOutput | undefined;
  let firstPermanent: SendOutput | undefined;
  let firstRendered: SendOutput | undefined;

  for (const unit of units) {
    // Unknown throws are deliberately not destructive. The row is already a
    // write-ahead record and will be retried with the same provider
    // idempotency key; deleting it here could hide an ambiguous acceptance.
    let send: SendOutput;
    try {
      send = await sendWithSuppressionCheck({
        db,
        env,
        sender: concreteSender,
        from,
        to: unit.visibleTo ?? unit.email,
        toName: unit.visibleTo ? undefined : unit.name,
        envelopeTo: unit.envelopeTo,
        cc: unit.cc,
        subject,
        html,
        text,
        headers,
        attachments,
        transactional,
        idempotencyKey: unit.id,
        onPrepared: async (wire) => {
          const prepared = await db
            .update(outboxEmails)
            .set({
              wireFrom: wire.from,
              wireTo: wire.to,
              wireCc:
                wire.cc && wire.cc.length > 0 ? JSON.stringify(wire.cc) : null,
              subject: wire.subject,
              bodyHtml: wire.html || null,
              bodyText: wire.text ?? null,
              headers: wire.headers ? JSON.stringify(wire.headers) : null,
              provider,
            })
            .where(
              and(
                eq(outboxEmails.id, unit.id),
                eq(outboxEmails.status, "pending"),
              ),
            )
            .returning({ id: outboxEmails.id });
          if (prepared.length === 0) throw new SendAbortedError();
        },
        beforeSend: async () => {
          await beforeSend?.();
          await beginProviderAttempt(db, unit.id, provider);
        },
      });
    } catch (err) {
      if (err instanceof SendAbortedError) {
        await db
          .delete(outboxEmails)
          .where(
            and(
              eq(outboxEmails.sentEmailId, sentEmailId),
              inArray(outboxEmails.status, ["pending", "sending"]),
            ),
          );
        throw err;
      }
      if (!(err instanceof EmailContentTooLargeError)) {
        if (providerSupportsAutomaticAmbiguousRetry(provider)) throw err;
        const state = await db
          .select({ status: outboxEmails.status })
          .from(outboxEmails)
          .where(eq(outboxEmails.id, unit.id))
          .limit(1);
        // Token/render/storage failures before the durable transport fence are
        // safe to retry. Only `sending` proves that the provider was invoked.
        if (state[0]?.status !== "sending") throw err;
        const failedAt = Math.floor(Date.now() / 1000);
        const message =
          `Ambiguous ${provider} delivery; manual review required: ${
            err instanceof Error ? err.message : String(err)
          }`.slice(0, 1000);
        await db
          .update(outboxEmails)
          .set({
            status: "failed",
            attempts: 1,
            lastError: message,
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(outboxEmails.sentEmailId, sentEmailId),
              inArray(outboxEmails.status, ["pending", "sending"]),
            ),
          );
        attempted.push(unit.email);
        firstPermanent ??= {
          delivered: [unit.email],
          suppressed: [],
          result: {
            id: null,
            error: { message, transient: false },
          },
        };
        break;
      }
      const failedAt = Math.floor(Date.now() / 1000);
      // Deterministic poison payload: none of the not-yet-attempted units may
      // be left pending for the hourly processor to retry forever.
      await db
        .update(outboxEmails)
        .set({
          status: "failed",
          attempts: 1,
          lastError: err.message,
          updatedAt: failedAt,
        })
        .where(
          and(
            eq(outboxEmails.sentEmailId, sentEmailId),
            inArray(outboxEmails.status, ["pending", "sending"]),
          ),
        );
      firstPermanent ??= {
        delivered: [unit.email],
        suppressed: [],
        result: {
          id: null,
          error: { message: err.message, transient: false },
        },
      };
      break;
    }
    const after = Math.floor(Date.now() / 1000);

    if (send.delivered.length === 0) {
      const removed = await db
        .delete(outboxEmails)
        .where(
          and(eq(outboxEmails.id, unit.id), eq(outboxEmails.status, "pending")),
        )
        .returning({ id: outboxEmails.id });
      if (removed.length === 0) {
        firstPermanent ??= {
          delivered: [unit.email],
          suppressed: [],
          result: {
            id: null,
            error: { message: "Send was cancelled", transient: false },
          },
        };
        break;
      }
      suppressed.push(...send.suppressed);
      continue;
    }

    attempted.push(...send.delivered);
    firstRendered ??= send;
    const result = send.result!;
    if (!result.error) {
      delivered.push(...send.delivered);
      firstSuccess ??= send;
      // Provider acceptance precedes permanent-history bookkeeping. A sent
      // marker is never claimable, while its stable idempotency key also
      // protects an ambiguous D1 response from duplicating Resend delivery.
      await db
        .update(outboxEmails)
        .set({
          status: "sent",
          providerMessageId: result.id,
          updatedAt: after,
        })
        .where(eq(outboxEmails.id, unit.id));
    } else if (
      result.error.ambiguous &&
      !providerSupportsAutomaticAmbiguousRetry(provider)
    ) {
      const message =
        `Ambiguous ${provider} delivery; manual review required: ${result.error.message}`.slice(
          0,
          1000,
        );
      firstPermanent ??= {
        ...send,
        result: {
          id: null,
          error: { message, transient: false, ambiguous: true },
        },
      };
      await db
        .update(outboxEmails)
        .set({
          status: "failed",
          attempts: 1,
          lastError: message,
          updatedAt: after,
        })
        .where(
          and(
            eq(outboxEmails.sentEmailId, sentEmailId),
            inArray(outboxEmails.status, ["pending", "sending"]),
          ),
        );
      break;
    } else if (result.error.transient) {
      const deferred = await db
        .update(outboxEmails)
        .set({
          status: "pending",
          attempts: 1,
          lastError: result.error.message,
          nextRetryAt: after + 60,
          updatedAt: after,
        })
        .where(
          and(
            eq(outboxEmails.id, unit.id),
            eq(outboxEmails.status, activeTransportStatus(provider)),
          ),
        )
        .returning({ id: outboxEmails.id });
      if (deferred.length === 0) {
        firstPermanent ??= {
          delivered: [unit.email],
          suppressed: [],
          result: {
            id: null,
            error: { message: "Send was cancelled", transient: false },
          },
        };
        break;
      }
      firstTransient ??= send;
    } else {
      firstPermanent ??= send;
      const failed = await db
        .update(outboxEmails)
        .set({
          status: "failed",
          attempts: 1,
          lastError: result.error.message,
          updatedAt: after,
        })
        .where(
          and(
            eq(outboxEmails.id, unit.id),
            eq(outboxEmails.status, activeTransportStatus(provider)),
          ),
        )
        .returning({ id: outboxEmails.id });
      if (failed.length === 0) break;
    }
  }

  const representative = firstTransient ?? firstPermanent ?? firstSuccess;
  const send: SendOutput = {
    delivered,
    attempted,
    suppressed,
    ...(representative?.result ? { result: representative.result } : {}),
    ...(firstRendered?.renderedHtml !== undefined
      ? { renderedHtml: firstRendered.renderedHtml }
      : {}),
    ...(firstRendered?.renderedText !== undefined
      ? { renderedText: firstRendered.renderedText }
      : {}),
  };

  if (firstTransient) return { outcome: "retrying", send };
  if (firstPermanent) {
    // Successful siblings remain as crash markers until the caller commits
    // aggregate history. The reconciler can then settle failed+sent groups.
    return { outcome: "failed", send };
  }
  if (firstSuccess) return { outcome: "sent", send };
  return { outcome: "suppressed", send };
}

/**
 * Delete the post-provider marker only after the caller has committed all of
 * its permanent bookkeeping (sent_emails, attachments, and sequence state).
 */
export async function finalizeSuccessfulOutbox(
  db: Db,
  sentEmailId: string,
): Promise<void> {
  await db
    .delete(outboxEmails)
    .where(
      and(
        eq(outboxEmails.sentEmailId, sentEmailId),
        eq(outboxEmails.status, "sent"),
      ),
    );
}

// Longer than any expected Worker invocation so recovery cannot race a live
// caller that is still committing richer permanent history.
const SENT_MARKER_GRACE_SECONDS = 30 * 60;

type OutboxRow = typeof outboxEmails.$inferSelect;

function compareOutboxUnitIds(
  a: { id: string },
  b: { id: string },
  sentEmailId: string,
): number {
  const rank = (id: string) =>
    !id.startsWith(`${sentEmailId}:`) || id.startsWith(`${sentEmailId}:000:`)
      ? 0
      : 1;
  return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
}

async function findOutboxPersonId(
  db: Db,
  row: OutboxRow,
  now: number,
): Promise<string | null> {
  if (row.sequenceEmailId) {
    const step = await db
      .select({ personId: sequenceEnrollments.personId })
      .from(sequenceEmails)
      .innerJoin(
        sequenceEnrollments,
        eq(sequenceEnrollments.id, sequenceEmails.enrollmentId),
      )
      .where(eq(sequenceEmails.id, row.sequenceEmailId))
      .limit(1);
    if (step[0]) return step[0].personId;
  }
  const canonicalEmail = row.toAddress.trim().toLowerCase();
  const person = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, canonicalEmail))
    .limit(1);
  if (person[0]) return person[0].id;

  // Compose creates a contact after provider acceptance. If the Worker dies
  // in that window, recovery must recreate the same relationship or the
  // repaired sent_emails row (and its attachments) disappears from the
  // contact thread forever.
  const candidateId = nanoid();
  await db
    .insert(people)
    .values({
      id: candidateId,
      email: canonicalEmail,
      name: null,
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: people.email });
  const created = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, canonicalEmail))
    .limit(1);
  return created[0]?.id ?? null;
}

async function findOutboxConversationId(
  db: Db,
  row: OutboxRow,
): Promise<string | null> {
  const cc = row.cc ? (JSON.parse(row.cc) as CcRecipient[]) : [];
  const identities = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  const internalDomains = Array.from(
    new Set(
      identities
        .map(({ email }) =>
          email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
  const externals = externalsOnly(
    [row.toAddress, ...cc.map((recipient) => recipient.email)],
    internalDomains,
  );
  return computeConversationId(row.fromAddress, externals);
}

/** Ensure retry/recovery always has a permanent history row to resolve. */
export async function ensureSentHistoryFromOutbox(
  db: Db,
  row: OutboxRow,
  status: "retrying" | "sent" | "failed",
  sentAt: number,
): Promise<void> {
  const siblings = await db
    .select()
    .from(outboxEmails)
    .where(eq(outboxEmails.sentEmailId, row.sentEmailId));
  // New unit ids carry an ordinal, making :000: the original To recipient.
  // Legacy groups have one row, so sorting is harmless there.
  const candidates = siblings.some((candidate) => candidate.id === row.id)
    ? siblings
    : [...siblings, row];
  const source =
    candidates.sort((a, b) => compareOutboxUnitIds(a, b, row.sentEmailId))[0] ??
    row;
  const parsedHeaders = source.headers
    ? (JSON.parse(source.headers) as Record<string, string>)
    : {};
  await db
    .insert(sentEmails)
    .values({
      id: row.sentEmailId,
      personId: await findOutboxPersonId(db, source, sentAt),
      fromAddress: source.fromAddress,
      toAddress: source.toAddress,
      subject: source.subject,
      bodyHtml: source.bodyHtml,
      bodyText: source.bodyText,
      inReplyTo: parsedHeaders["In-Reply-To"] ?? null,
      messageId: parsedHeaders["Message-ID"] ?? null,
      resendId: source.providerMessageId,
      status,
      cc: source.cc,
      conversationId: await findOutboxConversationId(db, source),
      sentAt,
      createdAt: source.createdAt,
    })
    .onConflictDoNothing();
}

/**
 * Resolve the aggregate status shared by all per-recipient outbox units.
 * Sent markers are cleared only when no retryable sibling remains.
 */
async function settleOutboxGroup(
  db: Db,
  row: OutboxRow,
  sentAt: number,
  providerId: string | null = null,
): Promise<OutboxOutcome> {
  const group = await db
    .select({
      id: outboxEmails.id,
      status: outboxEmails.status,
      providerMessageId: outboxEmails.providerMessageId,
    })
    .from(outboxEmails)
    .where(eq(outboxEmails.sentEmailId, row.sentEmailId));

  if (
    group.some((item) => item.status === "pending" || item.status === "sending")
  ) {
    await db
      .update(sentEmails)
      .set({ status: "retrying" })
      .where(eq(sentEmails.id, row.sentEmailId));
    return "retrying";
  }

  if (group.some((item) => item.status === "failed")) {
    await db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(eq(sentEmails.id, row.sentEmailId));
    if (row.sequenceEmailId) {
      await resolveSequenceStep(db, row.sequenceEmailId, "failed", null);
    }
    await finalizeSuccessfulOutbox(db, row.sentEmailId);
    await db
      .delete(outboxEmails)
      .where(
        and(
          eq(outboxEmails.sentEmailId, row.sentEmailId),
          eq(outboxEmails.status, "suppressed"),
        ),
      );
    return "failed";
  }

  if (group.some((item) => item.status === "sent")) {
    const canonicalProviderId =
      group
        .filter((item) => item.status === "sent" && item.providerMessageId)
        .sort((a, b) => compareOutboxUnitIds(a, b, row.sentEmailId))[0]
        ?.providerMessageId ?? providerId;
    await db
      .update(sentEmails)
      .set({
        status: "sent",
        sentAt,
        ...(canonicalProviderId ? { resendId: canonicalProviderId } : {}),
      })
      .where(eq(sentEmails.id, row.sentEmailId));
    if (row.sequenceEmailId) {
      await resolveSequenceStep(
        db,
        row.sequenceEmailId,
        "sent",
        row.sentEmailId,
      );
    }
    await finalizeSuccessfulOutbox(db, row.sentEmailId);
    await db
      .delete(outboxEmails)
      .where(
        and(
          eq(outboxEmails.sentEmailId, row.sentEmailId),
          eq(outboxEmails.status, "suppressed"),
        ),
      );
    return "sent";
  }

  // The only unit was suppressed between attempts and has been deleted.
  await db
    .update(sentEmails)
    .set({ status: "failed" })
    .where(eq(sentEmails.id, row.sentEmailId));
  if (row.sequenceEmailId) {
    await resolveSequenceStep(db, row.sequenceEmailId, "suppressed", null);
  }
  await db
    .delete(outboxEmails)
    .where(
      and(
        eq(outboxEmails.sentEmailId, row.sentEmailId),
        eq(outboxEmails.status, "suppressed"),
      ),
    );
  return "suppressed";
}

/** Repair terminal markers left between durable resolution and bookkeeping. */
export async function reconcileTerminalOutboxRows(
  db: Db,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  // Non-idempotent providers are fenced as `sending` immediately before the
  // transport call. A hard Worker interruption leaves that state behind; once
  // no invocation can still be alive, surface it for manual review instead of
  // issuing a potentially duplicate automatic retry.
  await db
    .update(outboxEmails)
    .set({
      status: "failed",
      lastError:
        "Ambiguous delivery after Worker interruption; manual review required",
    })
    .where(
      and(
        eq(outboxEmails.status, "sending"),
        lte(outboxEmails.updatedAt, now - SENT_MARKER_GRACE_SECONDS),
      ),
    );

  const ids = await db
    .select({ id: outboxEmails.id })
    .from(outboxEmails)
    .leftJoin(sentEmails, eq(sentEmails.id, outboxEmails.sentEmailId))
    .leftJoin(
      sequenceEmails,
      eq(sequenceEmails.id, outboxEmails.sequenceEmailId),
    )
    .leftJoin(
      sequenceEnrollments,
      eq(sequenceEnrollments.id, sequenceEmails.enrollmentId),
    )
    .where(
      or(
        and(
          eq(outboxEmails.status, "suppressed"),
          or(
            isNotNull(sentEmails.id),
            lte(outboxEmails.updatedAt, now - SENT_MARKER_GRACE_SECONDS),
          ),
          sql`NOT EXISTS (
            SELECT 1 FROM outbox_emails AS sibling
            WHERE sibling.sent_email_id = ${outboxEmails.sentEmailId}
              AND sibling.status IN ('pending', 'sending')
          )`,
        ),
        and(
          eq(outboxEmails.status, "failed"),
          or(
            and(
              isNull(sentEmails.id),
              lte(outboxEmails.updatedAt, now - SENT_MARKER_GRACE_SECONDS),
            ),
            eq(sentEmails.status, "retrying"),
            eq(sequenceEmails.status, "retrying"),
            like(sequenceEmails.status, "processing:%"),
            and(
              inArray(sequenceEmails.status, ["failed", "suppressed"]),
              eq(sequenceEnrollments.status, "active"),
              sql`NOT EXISTS (
                SELECT 1 FROM sequence_emails AS outstanding
                WHERE outstanding.enrollment_id = ${sequenceEnrollments.id}
                  AND (
                    outstanding.status IN ('pending', 'queued', 'retrying')
                    OR outstanding.status LIKE 'processing:%'
                  )
              )`,
            ),
          ),
        ),
      ),
    )
    .limit(OUTBOX_BATCH_LIMIT);

  let repaired = 0;
  const seen = new Set<string>();
  for (const marker of ids) {
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, marker.id))
      .limit(1);
    const row = rows[0];
    if (!row || seen.has(row.sentEmailId)) continue;
    seen.add(row.sentEmailId);
    try {
      await ensureSentHistoryFromOutbox(db, row, "failed", row.updatedAt);
      await settleOutboxGroup(db, row, row.updatedAt);
      repaired++;
    } catch (err) {
      console.error(
        `[outbox] terminal-marker repair failed for ${row.id}:`,
        err,
      );
    }
  }
  return repaired;
}

/**
 * Repair a Worker crash after provider acceptance but before the caller wrote
 * permanent history. Markers younger than thirty minutes may still belong to a
 * live request and are left alone to avoid racing its richer history write.
 */
export async function reconcileSentOutboxRows(
  db: Db,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const markers = await db
    .select()
    .from(outboxEmails)
    .where(
      and(
        eq(outboxEmails.status, "sent"),
        lte(outboxEmails.updatedAt, now - SENT_MARKER_GRACE_SECONDS),
      ),
    )
    .limit(OUTBOX_BATCH_LIMIT);

  let repaired = 0;
  const seen = new Set<string>();
  for (const row of markers) {
    if (seen.has(row.sentEmailId)) continue;
    seen.add(row.sentEmailId);
    try {
      const group = await db
        .select({
          id: outboxEmails.id,
          status: outboxEmails.status,
          providerMessageId: outboxEmails.providerMessageId,
        })
        .from(outboxEmails)
        .where(eq(outboxEmails.sentEmailId, row.sentEmailId));
      // A sent recipient can coexist with another recipient awaiting retry.
      // It is a partial-delivery marker, not a completed message.
      if (group.some((item) => item.status === "pending")) continue;
      await ensureSentHistoryFromOutbox(db, row, "sent", row.updatedAt);
      const providerId = group
        .filter((item) => item.status === "sent" && item.providerMessageId)
        .sort((a, b) =>
          compareOutboxUnitIds(a, b, row.sentEmailId),
        )[0]?.providerMessageId;
      await settleOutboxGroup(db, row, row.updatedAt, providerId ?? null);
      repaired++;
    } catch (err) {
      console.error(`[outbox] sent-marker repair failed for ${row.id}:`, err);
    }
  }
  return repaired;
}

/**
 * Cron entry point: re-attempt every due pending outbox row. Called from
 * the hourly `scheduled()` handler after sequence dispatch.
 */
export async function processOutbox(env: CloudflareBindings): Promise<void> {
  if (isDemoMode(env)) return;
  const db = drizzle(env.DB, { schema }) as unknown as Db;
  const sender = createEmailSender(env);
  const now = Math.floor(Date.now() / 1000);
  const repaired = await reconcileSentOutboxRows(db, now);
  const terminalRepaired = await reconcileTerminalOutboxRows(db, now);

  const due = await db
    .select({ id: outboxEmails.id })
    .from(outboxEmails)
    .where(
      and(
        eq(outboxEmails.status, "pending"),
        lte(outboxEmails.nextRetryAt, now),
      ),
    )
    .limit(OUTBOX_BATCH_LIMIT);
  if (due.length === 0) {
    if (repaired + terminalRepaired > 0) {
      console.log(
        `[outbox] repaired sent=${repaired} terminal=${terminalRepaired}`,
      );
    }
    return;
  }

  let claimed = 0;
  for (const row of due) {
    try {
      const result = await attemptOutboxRow(db, env, sender, row.id);
      if (result !== null) claimed++;
    } catch (err) {
      // A crashed attempt leaves the row pending with next_retry_at an hour
      // out (set by the claim), so it self-heals on a later run.
      console.error(`[outbox] retry attempt crashed for ${row.id}:`, err);
    }
  }
  console.log(
    `[outbox] processed ${claimed}/${due.length} due rows; repaired=${repaired + terminalRepaired}`,
  );
}

/**
 * Claim and re-attempt a single outbox row. Returns the resolution, or
 * null when the row couldn't be claimed (already resolved, status
 * `failed`, or not due — e.g. a concurrent processor got there first).
 *
 * The claim is a conditional UPDATE that bumps `attempts` and pushes
 * `next_retry_at` an hour out; a concurrent claimant fails the
 * `next_retry_at <= now` condition, so a cron run racing a manual retry
 * can't double-send.
 */
export async function attemptOutboxRow(
  db: Db,
  env: CloudflareBindings,
  sender: EmailSender,
  id: string,
): Promise<OutboxOutcome | null> {
  const now = Math.floor(Date.now() / 1000);
  const claimed = await db
    .update(outboxEmails)
    .set({
      attempts: sql`${outboxEmails.attempts} + 1`,
      nextRetryAt: now + 3600,
      updatedAt: now,
    })
    .where(
      and(
        eq(outboxEmails.id, id),
        eq(outboxEmails.status, "pending"),
        lte(outboxEmails.nextRetryAt, now),
      ),
    )
    .returning();
  if (claimed.length === 0) return null;
  const row = claimed[0];

  try {
    const storedCc = row.cc ? (JSON.parse(row.cc) as CcRecipient[]) : [];
    const legacySplit = await splitLegacyMarketingOutbox(
      db,
      row,
      storedCc,
      now,
    );
    if (legacySplit === "unsafe") {
      await db
        .update(outboxEmails)
        .set({
          status: "failed",
          lastError: "Legacy aggregate payload cannot be safely personalized",
          updatedAt: now,
        })
        .where(eq(outboxEmails.id, row.id));
      return settleOutboxGroup(db, row, now);
    }

    // The original request may have crashed immediately after recording the
    // transient outbox result, before it inserted sent_emails. Create the
    // recoverable history row before another provider attempt so resolution
    // updates can never target zero rows and disappear.
    await ensureSentHistoryFromOutbox(db, row, "retrying", row.createdAt);

    const snapshottedProvider = knownProvider(row.provider);

    const sequenceOwnership = await claimSequenceRetryOwnership(db, row);
    if (sequenceOwnership === "busy") return null;
    if (sequenceOwnership === "inactive") {
      const failedAt = Math.floor(Date.now() / 1000);
      await db
        .update(outboxEmails)
        .set({
          status: "failed",
          lastError: "Sequence is no longer active",
          updatedAt: failedAt,
        })
        .where(
          and(eq(outboxEmails.id, row.id), eq(outboxEmails.status, "pending")),
        );
      return settleOutboxGroup(db, row, failedAt);
    }

    const provider =
      snapshottedProvider ??
      (await concreteProviderForSend(db, sender, row.fromAddress));
    const splitCloudflareEnvelope =
      row.transactional === 1 &&
      provider === "cloudflare" &&
      row.id.startsWith(`${row.sentEmailId}:`);
    const retrySender =
      sender.provider === provider
        ? sender
        : createEmailSenderForProvider(env, provider);
    const from = row.wireFrom ?? (await formatFromAddress(db, row.fromAddress));
    let storedAttachments: SendEmailAttachment[];
    try {
      storedAttachments = await loadOutboxAttachments(db, env, row.sentEmailId);
    } catch (err) {
      if (!(err instanceof MissingOutboxAttachmentError)) throw err;
      const failedAt = Math.floor(Date.now() / 1000);
      await db
        .update(outboxEmails)
        .set({ status: "failed", lastError: err.message, updatedAt: failedAt })
        .where(eq(outboxEmails.id, row.id));
      return settleOutboxGroup(db, row, failedAt);
    }

    let send: SendOutput;
    try {
      if (row.wireFrom && knownProvider(row.provider)) {
        if (
          row.transactional !== 1 &&
          (await isSuppressed(db, row.toAddress))
        ) {
          send = { delivered: [], suppressed: [row.toAddress] };
        } else {
          await assertSequenceRetryActive(db, row);
          await beginProviderAttempt(db, row.id, provider);
          const result = await retrySender.send({
            from,
            to: row.wireTo ?? row.toAddress,
            ...(splitCloudflareEnvelope ? { envelopeTo: row.toAddress } : {}),
            ...(row.wireCc ? { cc: JSON.parse(row.wireCc) as string[] } : {}),
            subject: row.subject,
            html: row.bodyHtml ?? "",
            ...(row.bodyText !== null && row.bodyText !== undefined
              ? { text: row.bodyText }
              : {}),
            ...(row.headers
              ? {
                  headers: JSON.parse(row.headers) as Record<string, string>,
                }
              : {}),
            ...(storedAttachments.length > 0
              ? { attachments: storedAttachments }
              : {}),
            idempotencyKey: row.id,
          });
          send = {
            delivered: [row.toAddress],
            suppressed: [],
            result,
            ...(row.bodyHtml !== null ? { renderedHtml: row.bodyHtml } : {}),
            ...(row.bodyText !== null ? { renderedText: row.bodyText } : {}),
          };
        }
      } else {
        send = await sendWithSuppressionCheck({
          db,
          env,
          sender: retrySender,
          from,
          to: splitCloudflareEnvelope
            ? (row.wireTo ?? row.toAddress)
            : row.toAddress,
          envelopeTo: splitCloudflareEnvelope ? row.toAddress : undefined,
          toName:
            row.transactional !== 1 && row.id.startsWith(`${row.sentEmailId}:`)
              ? (storedCc.find((entry) => entry.email === row.toAddress)
                  ?.name ?? undefined)
              : undefined,
          cc:
            row.transactional === 1
              ? storedCc.length > 0
                ? storedCc
                : undefined
              : legacySplit === "none" &&
                  !row.id.startsWith(`${row.sentEmailId}:`)
                ? storedCc.length > 0
                  ? storedCc
                  : undefined
                : undefined,
          subject: row.subject,
          html: row.bodyHtml ?? undefined,
          text: row.bodyText ?? undefined,
          headers: row.headers
            ? (JSON.parse(row.headers) as Record<string, string>)
            : undefined,
          attachments:
            storedAttachments.length > 0 ? storedAttachments : undefined,
          transactional: row.transactional === 1,
          idempotencyKey: row.id,
          onPrepared: async (wire) => {
            const prepared = await db
              .update(outboxEmails)
              .set({
                wireFrom: wire.from,
                wireTo: wire.to,
                wireCc:
                  wire.cc && wire.cc.length > 0
                    ? JSON.stringify(wire.cc)
                    : null,
                subject: wire.subject,
                bodyHtml: wire.html || null,
                bodyText: wire.text ?? null,
                headers: wire.headers ? JSON.stringify(wire.headers) : null,
                provider,
              })
              .where(
                and(
                  eq(outboxEmails.id, row.id),
                  eq(outboxEmails.status, "pending"),
                ),
              )
              .returning({ id: outboxEmails.id });
            if (prepared.length === 0) throw new SendAbortedError();
          },
          beforeSend: async () => {
            await assertSequenceRetryActive(db, row);
            await beginProviderAttempt(db, row.id, provider);
          },
        });
      }
    } catch (err) {
      if (err instanceof SendAbortedError) {
        const failedAt = Math.floor(Date.now() / 1000);
        await db
          .update(outboxEmails)
          .set({
            status: "failed",
            lastError: err.message,
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(outboxEmails.id, row.id),
              inArray(outboxEmails.status, ["pending", "sending"]),
            ),
          );
        await db
          .update(sentEmails)
          .set({ status: "failed" })
          .where(eq(sentEmails.id, row.sentEmailId));
        return "failed";
      }
      if (!(err instanceof EmailContentTooLargeError)) throw err;
      const failedAt = Math.floor(Date.now() / 1000);
      await db
        .update(outboxEmails)
        .set({ status: "failed", lastError: err.message, updatedAt: failedAt })
        .where(eq(outboxEmails.id, row.id));
      return settleOutboxGroup(db, row, failedAt);
    }

    const after = Math.floor(Date.now() / 1000);

    if (send.delivered.length === 0) {
      // Mid-retry suppression: the recipient was added to the suppression list between
      // a previous attempt and this one. Terminal — delete the outbox row and don't retry.
      // sent_emails is set to "failed" (not "suppressed") because a transport was already
      // attempted on the initial inline call; "failed" is the only terminal sent-status
      // that doesn't render the message as delivered. The step-level "suppressed" below
      // preserves the precise reason for sequence reporting.
      await db
        .update(outboxEmails)
        .set({ status: "suppressed", updatedAt: after })
        .where(eq(outboxEmails.id, row.id));
      return settleOutboxGroup(db, row, after);
    }

    const result = send.result!;
    if (!result.error) {
      // Fence retry delivery immediately after provider acceptance. Any crash in
      // the history/sequence bookkeeping below leaves a non-claimable marker for
      // the reconciler instead of a pending row that would deliver twice.
      await db
        .update(outboxEmails)
        .set({
          status: "sent",
          providerMessageId: result.id,
          updatedAt: after,
        })
        .where(eq(outboxEmails.id, row.id));
      return settleOutboxGroup(db, row, after, result.id);
    }

    if (
      result.error.ambiguous &&
      !providerSupportsAutomaticAmbiguousRetry(provider)
    ) {
      const message =
        `Ambiguous ${provider} delivery; manual review required: ${result.error.message}`.slice(
          0,
          1000,
        );
      await db
        .update(outboxEmails)
        .set({ status: "failed", lastError: message, updatedAt: after })
        .where(
          and(eq(outboxEmails.id, row.id), eq(outboxEmails.status, "sending")),
        );
      return settleOutboxGroup(db, row, after);
    }

    if (result.error.transient && row.attempts < MAX_OUTBOX_ATTEMPTS) {
      // Due again immediately — i.e. at the next hourly run.
      const deferred = await db
        .update(outboxEmails)
        .set({
          status: "pending",
          lastError: result.error.message,
          nextRetryAt: after,
          updatedAt: after,
        })
        .where(
          and(
            eq(outboxEmails.id, row.id),
            eq(outboxEmails.status, activeTransportStatus(provider)),
          ),
        )
        .returning({ id: outboxEmails.id });
      if (deferred.length === 0) return settleOutboxGroup(db, row, after);
      // No-op on the normal cron path (already retrying); matters when a manual
      // retry revives a terminally failed row — flip the UI status back to
      // "retrying" so the thread and outbox stay in sync.
      await db
        .update(sentEmails)
        .set({ status: "retrying" })
        .where(eq(sentEmails.id, row.sentEmailId));
      return "retrying";
    }

    // Permanent reject, or the attempt budget is spent.
    await db
      .update(outboxEmails)
      .set({
        status: "failed",
        lastError: result.error.message,
        updatedAt: after,
      })
      .where(
        and(
          eq(outboxEmails.id, row.id),
          eq(outboxEmails.status, activeTransportStatus(provider)),
        ),
      );
    await db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(eq(sentEmails.id, row.sentEmailId));
    return settleOutboxGroup(db, row, after);
  } catch (err) {
    return recordUnexpectedAttemptFailure(db, row, err);
  }
}

async function recordUnexpectedAttemptFailure(
  db: Db,
  row: OutboxRow,
  err: unknown,
): Promise<OutboxOutcome> {
  const after = Math.floor(Date.now() / 1000);
  const message =
    (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(
      0,
      1000,
    ) || "Unknown outbox retry error";
  const current = await db
    .select({
      status: outboxEmails.status,
      providerMessageId: outboxEmails.providerMessageId,
      provider: outboxEmails.provider,
    })
    .from(outboxEmails)
    .where(eq(outboxEmails.id, row.id))
    .limit(1);

  // A D1 response can be ambiguous too. If the provider marker actually
  // committed, complete bookkeeping instead of making the row claimable.
  if (current[0]?.status === "sent") {
    return settleOutboxGroup(db, row, after, current[0].providerMessageId);
  }
  if (!current[0] || current[0].status === "failed") {
    return settleOutboxGroup(db, row, after);
  }

  const provider = knownProvider(current[0].provider);
  if (current[0].status === "sending" && provider) {
    await db
      .update(outboxEmails)
      .set({
        status: "failed",
        lastError:
          `Ambiguous ${provider} delivery; manual review required: ${message}`.slice(
            0,
            1000,
          ),
        updatedAt: after,
      })
      .where(
        and(eq(outboxEmails.id, row.id), eq(outboxEmails.status, "sending")),
      );
    return settleOutboxGroup(db, row, after);
  }

  if (row.attempts >= MAX_OUTBOX_ATTEMPTS) {
    await db
      .update(outboxEmails)
      .set({ status: "failed", lastError: message, updatedAt: after })
      .where(
        and(eq(outboxEmails.id, row.id), eq(outboxEmails.status, "pending")),
      );
    return settleOutboxGroup(db, row, after);
  }

  const deferred = await db
    .update(outboxEmails)
    .set({ lastError: message, nextRetryAt: after, updatedAt: after })
    .where(and(eq(outboxEmails.id, row.id), eq(outboxEmails.status, "pending")))
    .returning({ id: outboxEmails.id });
  if (deferred.length === 0) return settleOutboxGroup(db, row, after);
  await db
    .update(sentEmails)
    .set({ status: "retrying" })
    .where(eq(sentEmails.id, row.sentEmailId));
  return "retrying";
}

async function splitLegacyMarketingOutbox(
  db: Db,
  row: OutboxRow,
  cc: CcRecipient[],
  now: number,
): Promise<"none" | "split" | "unsafe"> {
  if (
    row.transactional === 1 ||
    row.id.startsWith(`${row.sentEmailId}:`) ||
    cc.length === 0
  ) {
    return "none";
  }
  // A prior version may already have overwritten bodyHtml with the primary
  // recipient's unsubscribe token. There is no safe way to personalize the
  // missing CC units from that canonical payload.
  if (row.wireFrom) return "unsafe";

  await db.batch(
    cc.map((entry, index) =>
      db
        .insert(outboxEmails)
        .values({
          id: `${row.sentEmailId}:legacy:${String(index + 1).padStart(3, "0")}:${row.id}`,
          sentEmailId: row.sentEmailId,
          sequenceEmailId: row.sequenceEmailId,
          fromAddress: row.fromAddress,
          toAddress: entry.email,
          cc: row.cc,
          subject: row.subject,
          bodyHtml: row.bodyHtml,
          bodyText: row.bodyText,
          headers: row.headers,
          transactional: 0,
          provider: row.provider,
          status: "pending",
          attempts: 0,
          nextRetryAt: now,
          createdAt: row.createdAt,
          updatedAt: now,
        })
        .onConflictDoNothing(),
    ) as any,
  );
  return "split";
}

async function claimSequenceRetryOwnership(
  db: Db,
  row: OutboxRow,
): Promise<"owned" | "busy" | "inactive"> {
  if (!row.sequenceEmailId) return "owned";
  const state = await db
    .select({
      status: sequenceEmails.status,
      enrollmentStatus: sequenceEnrollments.status,
    })
    .from(sequenceEmails)
    .innerJoin(
      sequenceEnrollments,
      eq(sequenceEnrollments.id, sequenceEmails.enrollmentId),
    )
    .where(eq(sequenceEmails.id, row.sequenceEmailId))
    .limit(1);
  if (!state[0] || state[0].enrollmentStatus !== "active") return "inactive";
  if (state[0].status === "retrying") return "owned";

  // The scheduler may have recovered an expired processing lease to queued
  // immediately before the outbox cron runs. Claim queued -> retrying so the
  // queued consumer and outbox cannot both cross the provider boundary.
  if (state[0].status === "queued") {
    const claimed = await db
      .update(sequenceEmails)
      .set({ status: "retrying" })
      .where(
        and(
          eq(sequenceEmails.id, row.sequenceEmailId),
          eq(sequenceEmails.status, "queued"),
        ),
      )
      .returning({ id: sequenceEmails.id });
    return claimed.length > 0 ? "owned" : "busy";
  }

  if (state[0].status.startsWith("processing:")) return "busy";
  return "inactive";
}

async function assertSequenceRetryActive(
  db: Db,
  row: OutboxRow,
): Promise<void> {
  if (!row.sequenceEmailId) return;
  const active = await db
    .select({ id: outboxEmails.id })
    .from(outboxEmails)
    .innerJoin(
      sequenceEmails,
      eq(sequenceEmails.id, outboxEmails.sequenceEmailId),
    )
    .innerJoin(
      sequenceEnrollments,
      eq(sequenceEnrollments.id, sequenceEmails.enrollmentId),
    )
    .where(
      and(
        eq(outboxEmails.id, row.id),
        eq(outboxEmails.status, "pending"),
        eq(sequenceEmails.status, "retrying"),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);
  if (active.length === 0) throw new SendAbortedError();
}

/** Flip a sequence step to its terminal status and re-check the enrollment. */
export async function resolveSequenceStep(
  db: Db,
  sequenceEmailId: string,
  status: "sent" | "failed" | "suppressed",
  sentEmailId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = await db
    .update(sequenceEmails)
    .set({
      status,
      ...(status === "sent" ? { sentAt: now, sentEmailId } : {}),
    })
    .where(
      and(
        eq(sequenceEmails.id, sequenceEmailId),
        or(
          eq(sequenceEmails.status, "retrying"),
          like(sequenceEmails.status, "processing:%"),
        ),
      ),
    )
    .returning({ enrollmentId: sequenceEmails.enrollmentId });

  if (resolved[0]) {
    await completeEnrollmentIfDone(db, resolved[0].enrollmentId);
    return;
  }

  // A crash can happen after the terminal step update but before enrollment
  // completion. Replaying the same resolution must finish that bookkeeping,
  // while a cancelled or differently-resolved step remains untouched.
  const existing = await db
    .select({
      status: sequenceEmails.status,
      enrollmentId: sequenceEmails.enrollmentId,
    })
    .from(sequenceEmails)
    .where(eq(sequenceEmails.id, sequenceEmailId))
    .limit(1);
  if (existing[0]?.status === status) {
    await completeEnrollmentIfDone(db, existing[0].enrollmentId);
  }
}

/** Reload persisted attachments (R2 bytes) for a retry attempt. */
async function loadOutboxAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<SendEmailAttachment[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
  const out: SendEmailAttachment[] = [];
  for (const a of rows) {
    const obj = await env.R2.get(a.r2Key);
    if (!obj) {
      throw new MissingOutboxAttachmentError(
        `Attachment bytes are missing for ${a.id}; refusing to send a changed message`,
      );
    }
    out.push({
      filename: a.filename,
      contentType: a.contentType,
      content: await obj.arrayBuffer(),
    });
  }
  return out;
}

class MissingOutboxAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingOutboxAttachmentError";
  }
}
