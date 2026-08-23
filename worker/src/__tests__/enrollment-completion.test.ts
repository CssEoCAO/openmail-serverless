import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { completeEnrollmentIfDone } from "../lib/enrollment-completion";

describe("completeEnrollmentIfDone", () => {
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
    await createTestPerson({ id: "person-1", email: "person@example.com" });
  });

  it("does not complete while a sibling step owns a processing claim", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sequences).values({
      id: "sequence-1",
      name: "Concurrent steps",
      steps: "[]",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enrollment-1",
      sequenceId: "sequence-1",
      personId: "person-1",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values([
      {
        id: "step-sent",
        enrollmentId: "enrollment-1",
        stepOrder: 1,
        templateSlug: "first",
        scheduledAt: now,
        status: "sent",
      },
      {
        id: "step-processing",
        enrollmentId: "enrollment-1",
        stepOrder: 2,
        templateSlug: "second",
        scheduledAt: now,
        status: `processing:${now}:worker-b`,
      },
    ]);

    await completeEnrollmentIfDone(db, "enrollment-1");
    let enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enrollment-1"));
    expect(enrollment[0].status).toBe("active");

    await db
      .update(sequenceEmails)
      .set({ status: "sent" })
      .where(eq(sequenceEmails.id, "step-processing"));
    await completeEnrollmentIfDone(db, "enrollment-1");
    enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enrollment-1"));
    expect(enrollment[0].status).toBe("completed");
  });
});
