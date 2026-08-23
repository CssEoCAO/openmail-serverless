import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte, like, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender, type EmailSender } from "./email-sender";
import { isDemoMode } from "./is-dev";
import { schema } from "../db/schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { renderTemplate, type TemplateVariables } from "./interpolate";
import { formatFromAddress, sanitizeHeaderValue } from "./format-from-address";
import { generateMessageId } from "./message-id";
import { finalizeSuccessfulOutbox, sendViaOutbox } from "./outbox";
import { fitsD1EmailTextBudget } from "./email-limits";
import { completeEnrollmentIfDone } from "./enrollment-completion";
import { SendAbortedError } from "./send";
import { templateCanSendFrom } from "./template-access";

export interface SequenceEmailMessage {
  sequenceEmailId: string;
}

const SCHEDULED_BATCH_LIMIT = 500;
const PROCESSING_PREFIX = "processing:";
// Queue consumer invocations have a bounded lifetime. Keep the lease longer
// than that lifetime so the scheduler cannot hand the same step to a second
// consumer while the first can still reach the provider.
const PROCESSING_LEASE_SECONDS = 30 * 60;

function processingStatus(now: number): string {
  return `${PROCESSING_PREFIX}${now}:${crypto.randomUUID()}`;
}

function processingStartedAt(status: string): number | null {
  if (!status.startsWith(PROCESSING_PREFIX)) return null;
  const value = Number(status.split(":", 3)[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Cron handler: find due pending emails and push them onto the queue.
 */
export async function handleScheduled(env: CloudflareBindings): Promise<void> {
  // Demo deploys have no EMAIL_QUEUE binding and no cron trigger, but guard
  // here too so this can't crash if invoked manually.
  if (isDemoMode(env)) {
    console.log("[demo] Skipping scheduled sequence dispatch");
    return;
  }
  const db = drizzle(env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  // Include already-queued rows as a recovery path. The producer must mark a
  // row queued before publishing so the consumer recognizes it; if the Queue
  // send then throws (or the isolate dies in between), a pending-only scan
  // loses that step forever. Redelivery is safe because the consumer only acts
  // while the row is still `queued`.
  const dueEmails = await db
    .select({ id: sequenceEmails.id, status: sequenceEmails.status })
    .from(sequenceEmails)
    .where(
      and(
        or(
          eq(sequenceEmails.status, "pending"),
          eq(sequenceEmails.status, "queued"),
          like(sequenceEmails.status, `${PROCESSING_PREFIX}%`),
        ),
        lte(sequenceEmails.scheduledAt, now),
      ),
    )
    .limit(SCHEDULED_BATCH_LIMIT);

  if (dueEmails.length === 0) return;

  let enqueued = 0;
  let failed = 0;
  for (const email of dueEmails) {
    if (email.status.startsWith(PROCESSING_PREFIX)) {
      const startedAt = processingStartedAt(email.status);
      if (startedAt !== null && startedAt > now - PROCESSING_LEASE_SECONDS) {
        continue;
      }

      // A Worker can die after atomically claiming a Queue delivery. Recover
      // only an expired (or malformed legacy) claim, and compare the full
      // token so a newer consumer can never be overwritten.
      const recovered = await db
        .update(sequenceEmails)
        .set({ status: "queued" })
        .where(
          and(
            eq(sequenceEmails.id, email.id),
            eq(sequenceEmails.status, email.status),
          ),
        )
        .returning({ id: sequenceEmails.id });
      if (recovered.length === 0) continue;
    }

    if (email.status === "pending") {
      const claimed = await db
        .update(sequenceEmails)
        .set({ status: "queued" })
        .where(
          and(
            eq(sequenceEmails.id, email.id),
            eq(sequenceEmails.status, "pending"),
          ),
        )
        .returning({ id: sequenceEmails.id });
      if (claimed.length === 0) continue;
    }

    const message: SequenceEmailMessage = { sequenceEmailId: email.id };
    try {
      await env.EMAIL_QUEUE.send(message);
      enqueued++;
    } catch (err) {
      // Leave the row queued; the next scheduled scan republishes it.
      failed++;
      console.error(`[sequence] queue publish failed for ${email.id}:`, err);
    }
  }

  console.log(
    `[sequence] queue dispatch enqueued=${enqueued} failed=${failed} scanned=${dueEmails.length}`,
  );
}

/**
 * Queue consumer: process a batch of sequence email messages.
 */
export async function handleQueueBatch(
  batch: MessageBatch<SequenceEmailMessage>,
  env: CloudflareBindings,
): Promise<void> {
  if (isDemoMode(env)) {
    // No queue binding exists in demo, so this should never fire — ack
    // anything that somehow lands here so it doesn't infinitely retry.
    for (const msg of batch.messages) msg.ack();
    return;
  }
  const db = drizzle(env.DB, { schema });
  const sender = createEmailSender(env);

  for (const msg of batch.messages) {
    try {
      await processSequenceEmail(db, sender, env, msg.body.sequenceEmailId);
      msg.ack();
    } catch (err) {
      console.error(
        `Failed to process sequence email ${msg.body.sequenceEmailId}:`,
        err,
      );
      // processSequenceEmail releases only its own exact fencing token.
      msg.retry();
    }
  }
}

/**
 * Mark a step terminally failed and settle the enrollment.
 *
 * Every terminal branch must go through here rather than updating the row and
 * returning. `completeEnrollmentIfDone` lives at the very end of
 * `processSequenceEmail`, so an early return skips it and leaves the
 * enrollment `active` with no outstanding steps — and since
 * `enrollPersonInSequence` refuses to enroll anyone who already has an active
 * enrollment, that contact can never be enrolled in any sequence again. A
 * failed final step should end the drip, not wedge the person.
 */
async function failStep(
  db: ReturnType<typeof drizzle>,
  sequenceEmailId: string,
  enrollmentId: string,
  claim: string,
): Promise<boolean> {
  const failed = await db
    .update(sequenceEmails)
    .set({ status: "failed" })
    .where(
      and(
        eq(sequenceEmails.id, sequenceEmailId),
        eq(sequenceEmails.status, claim),
      ),
    )
    .returning({ id: sequenceEmails.id });
  if (failed.length === 0) return false;
  await completeEnrollmentIfDone(db, enrollmentId);
  return true;
}

export async function processSequenceEmail(
  db: ReturnType<typeof drizzle>,
  sender: EmailSender,
  env: CloudflareBindings,
  sequenceEmailId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch the outbox row
  const emailRows = await db
    .select()
    .from(sequenceEmails)
    .where(eq(sequenceEmails.id, sequenceEmailId))
    .limit(1);

  if (emailRows.length === 0) return;
  const seqEmail = emailRows[0];

  // Bail if not queued (already cancelled or sent)
  if (seqEmail.status !== "queued") return;

  // Queue delivery is at-least-once. Claim the step with a unique lease token
  // before reading/rendering/sending so concurrent redeliveries cannot both
  // observe `queued` and deliver duplicate mail.
  const claim = processingStatus(now);
  const claimed = await db
    .update(sequenceEmails)
    .set({ status: claim })
    .where(
      and(
        eq(sequenceEmails.id, sequenceEmailId),
        eq(sequenceEmails.status, "queued"),
      ),
    )
    .returning({ id: sequenceEmails.id });
  if (claimed.length === 0) return;

  try {
    // Fetch enrollment — bail if not active
    const enrollmentRows = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, seqEmail.enrollmentId))
      .limit(1);

    if (enrollmentRows.length === 0) {
      await db
        .update(sequenceEmails)
        .set({ status: "failed" })
        .where(
          and(
            eq(sequenceEmails.id, sequenceEmailId),
            eq(sequenceEmails.status, claim),
          ),
        );
      return;
    }
    const enrollment = enrollmentRows[0];

    const fromAddress = enrollment.fromAddress;

    if (enrollment.status !== "active") {
      // Enrollment was cancelled while queued — mark email as cancelled
      await db
        .update(sequenceEmails)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(sequenceEmails.id, sequenceEmailId),
            eq(sequenceEmails.status, claim),
          ),
        );
      return;
    }

    // Crash-redelivery guard: if the queue message is redelivered after a crash
    // mid-bookkeeping (e.g. the sentEmails insert threw), an outbox row may already
    // exist for this step even though the step status is still "queued". Sending again
    // would insert a second outbox row and generate a duplicate email. Instead, repair:
    // insert the missing sentEmails row (no-op if it already exists) and flip the step
    // to "retrying" so the outbox owns the retry from here.
    const existingOutboxRows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sequenceEmailId, sequenceEmailId))
      .limit(1);
    if (existingOutboxRows.length > 0) {
      const outboxRow = existingOutboxRows[0];
      const repairNow = Math.floor(Date.now() / 1000);
      const repairedStatus =
        outboxRow.status === "sent"
          ? "sent"
          : outboxRow.status === "failed"
            ? "failed"
            : "retrying";
      await db
        .insert(sentEmails)
        .values({
          id: outboxRow.sentEmailId,
          personId: enrollment.personId,
          fromAddress: outboxRow.fromAddress,
          toAddress: outboxRow.toAddress,
          subject: outboxRow.subject,
          bodyHtml: outboxRow.bodyHtml ?? null,
          bodyText: outboxRow.bodyText ?? null,
          messageId: outboxRow.headers
            ? (JSON.parse(outboxRow.headers)["Message-ID"] ?? null)
            : null,
          resendId: outboxRow.providerMessageId,
          status: repairedStatus,
          sentAt: repairedStatus === "sent" ? outboxRow.updatedAt : repairNow,
          createdAt: repairNow,
        })
        .onConflictDoNothing();
      if (repairedStatus === "sent") {
        const transitioned = await db
          .update(sequenceEmails)
          .set({
            status: "sent",
            sentAt: repairNow,
            sentEmailId: outboxRow.sentEmailId,
          })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
        // This row is a post-send crash marker, not a retry job.
        await db.delete(outboxEmails).where(eq(outboxEmails.id, outboxRow.id));
        await completeEnrollmentIfDone(db, enrollment.id);
      } else if (repairedStatus === "failed") {
        const transitioned = await db
          .update(sequenceEmails)
          .set({ status: "failed" })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
        await completeEnrollmentIfDone(db, enrollment.id);
      } else {
        const transitioned = await db
          .update(sequenceEmails)
          .set({ status: "retrying" })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
      }
      return;
    }

    // Fetch the template
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, seqEmail.templateSlug))
      .limit(1);

    if (templateRows.length === 0) {
      await failStep(db, sequenceEmailId, enrollment.id, claim);
      return;
    }

    const template = templateRows[0];
    // A deleted slug may be recreated by a different inbox while this step is
    // pending. Never let that new tenant's content be sent from the enrollment
    // sender merely because the public slug happens to match.
    if (!templateCanSendFrom(template.fromAddress, fromAddress)) {
      await failStep(db, sequenceEmailId, enrollment.id, claim);
      return;
    }

    // Fetch person for auto-variables
    const personRows = await db
      .select()
      .from(people)
      .where(eq(people.id, enrollment.personId))
      .limit(1);

    if (personRows.length === 0) {
      await failStep(db, sequenceEmailId, enrollment.id, claim);
      return;
    }

    const person = personRows[0];

    // Merge variables: person auto-vars + enrollment custom vars (custom wins)
    const customVars: TemplateVariables = JSON.parse(enrollment.variables);
    const mergedVars: TemplateVariables = {
      name: person.name ?? "",
      email: person.email,
      ...customVars,
    };

    // Use the same required-variable, shape, parse, nesting, and output-budget
    // validation as direct template sends. A drip must never mail literal
    // placeholders just because its variables were incomplete.
    const rendered = renderTemplate(template, mergedVars);
    if (!rendered.ok) {
      console.error(
        "[sequence] template render rejected",
        JSON.stringify({
          sequenceEmailId,
          templateSlug: seqEmail.templateSlug,
          missingVariables: rendered.missingVariables,
          error: rendered.parseError,
        }),
      );
      await failStep(db, sequenceEmailId, enrollment.id, claim);
      return;
    }
    const renderedSubject = sanitizeHeaderValue(rendered.subject);
    const renderedHtml = rendered.bodyHtml;

    const messageId = generateMessageId(fromAddress);
    const headers = { "Message-ID": messageId };
    if (
      !fitsD1EmailTextBudget(
        fromAddress,
        person.email,
        renderedSubject,
        renderedHtml,
        JSON.stringify(headers),
      )
    ) {
      console.error(
        "[sequence] rendered email exceeds storage limit",
        JSON.stringify({
          sequenceEmailId,
          templateSlug: seqEmail.templateSlug,
        }),
      );
      await failStep(db, sequenceEmailId, enrollment.id, claim);
      return;
    }
    const formattedFrom = await formatFromAddress(db, fromAddress);
    const sentId = nanoid();
    // Final fence immediately before the external side effect. Combined with a
    // lease longer than the invocation lifetime, this prevents an expired
    // consumer from reaching the provider after a newer consumer has claimed.
    const ownsClaim = await db
      .update(sequenceEmails)
      .set({ status: claim })
      .where(
        and(
          eq(sequenceEmails.id, sequenceEmailId),
          eq(sequenceEmails.status, claim),
        ),
      )
      .returning({ id: sequenceEmails.id });
    if (ownsClaim.length === 0) return;
    const { outcome, send: sendResult } = await sendViaOutbox({
      db,
      env,
      sender,
      sentEmailId: sentId,
      sequenceEmailId,
      fromAddress,
      from: formattedFrom,
      to: person.email,
      subject: renderedSubject,
      html: renderedHtml,
      headers,
      beforeSend: async () => {
        const active = await db
          .select({ id: sequenceEmails.id })
          .from(sequenceEmails)
          .innerJoin(
            sequenceEnrollments,
            eq(sequenceEnrollments.id, sequenceEmails.enrollmentId),
          )
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
              eq(sequenceEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (active.length === 0) throw new SendAbortedError();
      },
    });

    if (outcome === "suppressed") {
      // Recipient is on the suppression list — skip transport, mark suppressed,
      // do NOT retry. Suppression is a final state. sentAt's semantic is "time
      // the transport was called" — no transport call happened, so it stays null.
      console.log(
        "[sequence] recipient suppressed",
        JSON.stringify({
          sequenceEmailId,
          from: fromAddress,
          suppressed: sendResult.suppressed,
        }),
      );
      const transitioned = await db
        .update(sequenceEmails)
        .set({ status: "suppressed" })
        .where(
          and(
            eq(sequenceEmails.id, sequenceEmailId),
            eq(sequenceEmails.status, claim),
          ),
        )
        .returning({ id: sequenceEmails.id });
      if (transitioned.length === 0) return;
    } else {
      const result = sendResult.result!;

      // Store sent email record. The helper may have mutated the body to
      // interpolate {{unsubscribe_url}} or auto-append a footer — record
      // exactly what was on the wire, not the pre-helper template render.
      await db.insert(sentEmails).values({
        id: sentId,
        personId: person.id,
        fromAddress,
        toAddress: person.email,
        subject: renderedSubject,
        bodyHtml: sendResult.renderedHtml ?? renderedHtml,
        bodyText: sendResult.renderedText ?? null,
        messageId,
        resendId: result.id,
        status: outcome,
        sentAt: now,
        createdAt: now,
      });

      if (outcome === "retrying") {
        // The outbox owns the retry from here; the queue message is ACKed.
        const transitioned = await db
          .update(sequenceEmails)
          .set({ status: "retrying" })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
        return;
      }

      if (outcome === "failed") {
        const transitioned = await db
          .update(sequenceEmails)
          .set({ status: "failed" })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
        await finalizeSuccessfulOutbox(db, sentId);
      } else {
        const transitioned = await db
          .update(sequenceEmails)
          .set({ status: "sent", sentAt: now, sentEmailId: sentId })
          .where(
            and(
              eq(sequenceEmails.id, sequenceEmailId),
              eq(sequenceEmails.status, claim),
            ),
          )
          .returning({ id: sequenceEmails.id });
        if (transitioned.length === 0) return;
        // sendViaOutbox keeps a delivered sequence row as a crash marker until
        // both permanent-history and step bookkeeping have committed.
        await finalizeSuccessfulOutbox(db, sentId);
      }
    }

    await completeEnrollmentIfDone(db, enrollment.id);
  } catch (err) {
    // Release only this consumer's token. If the scheduler has ever replaced
    // it, the stale consumer cannot overwrite the newer claim or terminal
    // state on its way out.
    await db
      .update(sequenceEmails)
      .set({ status: "queued" })
      .where(
        and(
          eq(sequenceEmails.id, sequenceEmailId),
          eq(sequenceEmails.status, claim),
        ),
      );
    throw err;
  }
}
