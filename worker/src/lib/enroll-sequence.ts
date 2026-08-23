import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { people } from "../db/people.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { isDemoMode } from "./is-dev";
import type { TemplateVariables } from "./interpolate";
import type { SequenceEmailMessage } from "./sequence-processor";
import { canReadTemplate, templateCanSendFrom } from "./template-access";
import { getPersonScoped } from "./queries/people";

export const MAX_SEQUENCE_STEPS = 50;
/** Ten years per step is already far beyond a useful drip horizon. */
export const MAX_SEQUENCE_DELAY_HOURS = 24 * 365 * 10;

export type EnrollSequenceInput = {
  personId?: string;
  personEmail?: string;
  fromAddress: string;
  variables: TemplateVariables;
  skipSteps: number[];
  delayOverrides: Record<string, number>;
};

export type EnrollSequenceParams = {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  sequenceId: string;
  input: EnrollSequenceInput;
  allowed: AllowedInboxes;
};

export type EnrollmentRecord = {
  id: string;
  sequenceId: string;
  personId: string;
  fromAddress: string;
  status: string;
  variables: TemplateVariables;
  enrolledAt: number;
  cancelledAt: number | null;
};

export type ScheduledEmailRecord = {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledAt: number;
  status: string;
  sentAt: number | null;
  sentEmailId: string | null;
};

export type EnrollSequenceSuccess = {
  ok: true;
  enrollment: EnrollmentRecord;
  scheduledEmails: ScheduledEmailRecord[];
};

export type EnrollSequenceFailure = {
  ok: false;
  code:
    | "SEQUENCE_NOT_FOUND"
    | "PERSON_NOT_FOUND"
    | "ALREADY_ENROLLED"
    | "INVALID_OPTIONS"
    | "NO_STEPS_REMAINING";
  message: string;
};

export type EnrollSequenceResult =
  | EnrollSequenceSuccess
  | EnrollSequenceFailure;

/** Schedules land on hour boundaries so batched steps share a cron tick. */
function snapToNextHour(timestampSeconds: number): number {
  const ms = timestampSeconds * 1000;
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return Math.floor(date.getTime() / 1000);
}

/**
 * Enroll a person into a sequence, computing every scheduled send time upfront.
 *
 * Failure modes callers must surface are returned rather than thrown so this
 * can back both the HTTP route and the MCP tool; only the inbox permission
 * check throws (HTTPException), matching the routers' existing behavior.
 */
export async function enrollPersonInSequence(
  params: EnrollSequenceParams,
): Promise<EnrollSequenceResult> {
  const { db, env, sequenceId, input, allowed } = params;
  const {
    personId: inputPersonId,
    personEmail: rawPersonEmail,
    fromAddress: rawFromAddress,
    variables,
    skipSteps,
    delayOverrides,
  } = input;
  const fromAddress = rawFromAddress.trim().toLowerCase();
  const personEmail = rawPersonEmail?.trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  // Check inbox permission before any other work
  assertInboxAllowed(allowed, fromAddress);

  // Validate sequence exists
  const seqRows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId))
    .limit(1);

  if (seqRows.length === 0) {
    return {
      ok: false,
      code: "SEQUENCE_NOT_FOUND",
      message: "Sequence not found",
    };
  }

  const steps: Array<{
    order: number;
    templateSlug: string;
    delayHours: number;
  }> = JSON.parse(seqRows[0].steps);
  if (
    steps.length > MAX_SEQUENCE_STEPS ||
    new Set(steps.map((step) => step.order)).size !== steps.length ||
    steps.some(
      (step) =>
        !Number.isSafeInteger(step.order) ||
        step.order < 1 ||
        !Number.isSafeInteger(step.delayHours) ||
        step.delayHours < 0 ||
        step.delayHours > MAX_SEQUENCE_DELAY_HOURS,
    )
  ) {
    return {
      ok: false,
      code: "SEQUENCE_NOT_FOUND",
      message: "Sequence not found",
    };
  }

  const stepOrders = new Set(steps.map((step) => step.order));
  const skipOrderSet = new Set(skipSteps);
  const overrideOrders = Object.keys(delayOverrides);
  if (
    skipSteps.length > MAX_SEQUENCE_STEPS ||
    skipOrderSet.size !== skipSteps.length ||
    overrideOrders.length > MAX_SEQUENCE_STEPS ||
    skipSteps.some((order) => !stepOrders.has(order)) ||
    overrideOrders.some((order) => {
      const parsed = Number(order);
      return !Number.isInteger(parsed) || !stepOrders.has(parsed);
    })
  ) {
    return {
      ok: false,
      code: "INVALID_OPTIONS",
      message: "Skip and delay overrides must reference unique existing steps",
    };
  }

  // Filter and authorize the exact templates that would be sent before
  // creating a person or enrollment. Sequence definitions are shared, but a
  // member must not use a known slug to render another inbox's template.
  const activeSteps = steps
    .filter((s) => !skipOrderSet.has(s.order))
    .sort((a, b) => a.order - b.order);
  if (activeSteps.length === 0) {
    return {
      ok: false,
      code: "NO_STEPS_REMAINING",
      message: "At least one step must remain after skipping",
    };
  }
  const slugs = Array.from(
    new Set(activeSteps.map((step) => step.templateSlug)),
  );
  const templateRows = await db
    .select({
      slug: emailTemplates.slug,
      fromAddress: emailTemplates.fromAddress,
    })
    .from(emailTemplates)
    .where(inArray(emailTemplates.slug, slugs));
  const templatesBySlug = new Map(
    templateRows.map((template) => [template.slug, template]),
  );
  for (const step of activeSteps) {
    const template = templatesBySlug.get(step.templateSlug);
    if (
      !template ||
      !canReadTemplate(allowed, template.fromAddress) ||
      !templateCanSendFrom(template.fromAddress, fromAddress)
    ) {
      return {
        ok: false,
        code: "SEQUENCE_NOT_FOUND",
        message: "Sequence not found",
      };
    }
  }

  // Resolve person: by ID, or by email (create if needed)
  let personId: string;
  if (inputPersonId) {
    // A known id must not be a blind cross-inbox sending primitive. Require
    // the same correspondence-based visibility as GET /people/:id; admins
    // still short-circuit the scope helper.
    const visiblePerson = await getPersonScoped(db, inputPersonId, allowed);
    if (!visiblePerson) {
      return {
        ok: false,
        code: "PERSON_NOT_FOUND",
        message: "Person not found",
      };
    }
    personId = inputPersonId;
  } else {
    // personEmail is guaranteed by the schema refinement
    const existing = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, personEmail!))
      .limit(1);

    if (existing.length > 0) {
      personId = existing[0].id;
    } else {
      personId = nanoid();
      await db.insert(people).values({
        id: personId,
        email: personEmail!,
        name: null,
        lastEmailAt: now,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Check person is not already in an active sequence
  const existingEnrollment = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.personId, personId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);

  if (existingEnrollment.length > 0) {
    return {
      ok: false,
      code: "ALREADY_ENROLLED",
      message: "Person is already in an active sequence",
    };
  }

  // Create enrollment
  const enrollmentId = nanoid();
  const enrollment = {
    id: enrollmentId,
    sequenceId,
    personId,
    fromAddress,
    status: "active",
    variables: JSON.stringify(variables),
    enrolledAt: now,
    cancelledAt: null,
  };
  // Create outbox emails with computed schedule
  // First email sends immediately; subsequent emails accumulate delays from
  // snapToNextHour(now) so each step fires delayHours after the previous one.
  const baseTime = snapToNextHour(now);
  let cumulativeHours = 0;
  const scheduledEmails = activeSteps.map((step, index) => {
    const delayHours =
      step.order.toString() in delayOverrides
        ? delayOverrides[step.order.toString()]
        : step.delayHours;

    const isFirstEmail = index === 0;
    if (!isFirstEmail) cumulativeHours += delayHours;
    const scheduledAt = isFirstEmail ? now : baseTime + cumulativeHours * 3600;
    if (!Number.isSafeInteger(scheduledAt)) {
      throw new RangeError("Sequence schedule exceeds the supported horizon");
    }
    return {
      id: nanoid(),
      enrollmentId,
      stepOrder: step.order,
      templateSlug: step.templateSlug,
      scheduledAt,
      // In demo mode there is no queue/cron to advance "queued" emails, so
      // leave everything as "pending" — the records exist for the UI to show
      // but nothing is dispatched.
      status: isDemoMode(env) ? "pending" : isFirstEmail ? "queued" : "pending",
      sentAt: null,
      sentEmailId: null,
    };
  });

  // One multi-row insert would exceed D1's 100-bound-parameter ceiling at
  // roughly 13 steps. Individual statements inside a batch stay bounded and
  // atomically avoid an active enrollment with only part of its schedule.
  try {
    await db.batch([
      db.insert(sequenceEnrollments).values(enrollment),
      ...scheduledEmails.map((email) =>
        db.insert(sequenceEmails).values(email),
      ),
    ] as any);
  } catch (err) {
    // A lost D1 response may mean our transaction committed. Check our id
    // first; otherwise the partial unique index identifies the concurrent
    // winner and turns the constraint error into the API's stable result.
    const own = await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, enrollmentId))
      .limit(1);
    if (own.length === 0) {
      const winner = await db
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.personId, personId),
            eq(sequenceEnrollments.status, "active"),
          ),
        )
        .limit(1);
      if (winner.length > 0) {
        return {
          ok: false,
          code: "ALREADY_ENROLLED",
          message: "Person is already in an active sequence",
        };
      }
      throw err;
    }
  }

  // Immediately queue the first email so it sends without waiting for cron.
  // Skipped in demo mode where no EMAIL_QUEUE binding exists.
  if (!isDemoMode(env)) {
    const firstEmail = scheduledEmails[0];
    const message: SequenceEmailMessage = { sequenceEmailId: firstEmail.id };
    await env.EMAIL_QUEUE.send(message);
  }

  return {
    ok: true,
    enrollment: { ...enrollment, variables },
    scheduledEmails,
  };
}
