import { eq, and, inArray, like, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";

/** Invalidate queued, in-flight, and retry-owned work for one enrollment. */
export async function cancelEnrollmentSteps(
  db: DrizzleD1Database<any>,
  enrollmentId: string,
): Promise<void> {
  const cancellable = or(
    inArray(sequenceEmails.status, ["pending", "queued", "retrying"]),
    like(sequenceEmails.status, "processing:%"),
  );
  const steps = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(and(eq(sequenceEmails.enrollmentId, enrollmentId), cancellable));
  if (steps.length === 0) return;

  const stepIds = steps.map((step) => step.id);
  const queued = await db
    .select({ sentEmailId: outboxEmails.sentEmailId })
    .from(outboxEmails)
    .where(
      and(
        inArray(outboxEmails.sequenceEmailId, stepIds),
        eq(outboxEmails.status, "pending"),
      ),
    );

  // Invalidate processing fencing tokens first. A consumer that has not yet
  // crossed the provider boundary will fail its final guard.
  await db
    .update(sequenceEmails)
    .set({ status: "cancelled" })
    .where(and(eq(sequenceEmails.enrollmentId, enrollmentId), cancellable));

  await db
    .update(outboxEmails)
    .set({
      status: "failed",
      lastError: "Sequence cancelled",
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(
      and(
        inArray(outboxEmails.sequenceEmailId, stepIds),
        eq(outboxEmails.status, "pending"),
      ),
    );

  const sentIds = Array.from(new Set(queued.map((row) => row.sentEmailId)));
  if (sentIds.length > 0) {
    await db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(inArray(sentEmails.id, sentIds));
  }
}

/**
 * Cancel all active sequence enrollments for a given person.
 * Called when any email exchange occurs (inbound or outbound).
 */
export async function cancelSequencesForPerson(
  db: DrizzleD1Database<any>,
  personId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Find active enrollments for this person
  const activeEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.personId, personId),
        eq(sequenceEnrollments.status, "active"),
      ),
    );

  if (activeEnrollments.length === 0) return;

  const enrollmentIds = activeEnrollments.map((e) => e.id);

  // Cancel the enrollments
  for (const enrollmentId of enrollmentIds) {
    const cancelled = await db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", cancelledAt: now })
      .where(
        and(
          eq(sequenceEnrollments.id, enrollmentId),
          eq(sequenceEnrollments.status, "active"),
        ),
      )
      .returning({ id: sequenceEnrollments.id });
    if (cancelled.length > 0) await cancelEnrollmentSteps(db, enrollmentId);
  }
}
