import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  createTestTemplate,
  authFetch,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

describe("sequences router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  async function createSequenceWithTemplates() {
    await createTestTemplate({ slug: "welcome" });
    await createTestTemplate({
      slug: "follow-up",
      name: "Follow Up",
      subject: "Follow up",
      bodyHtml: "<p>Following up</p>",
    });

    const res = await authFetch("/api/sequences", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Onboarding",
        steps: [
          { order: 1, templateSlug: "welcome", delayHours: 0 },
          { order: 2, templateSlug: "follow-up", delayHours: 24 },
        ],
      }),
    });
    return res.json();
  }

  it("lets members read and enroll, but rejects global sequence mutations", async () => {
    const sequence = await createSequenceWithTemplates();
    const { apiKey: memberApiKey, userId } = await createTestUser({
      id: "sequence-member",
      role: "member",
      email: "sequence-member@example.com",
    });
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId,
        email: "me@saasmail.test",
        createdAt: Math.floor(Date.now() / 1000),
      });
    await createTestPerson({
      id: "member-person",
      email: "member-person@example.com",
    });
    await createTestEmail({
      id: "member-email",
      personId: "member-person",
      recipient: "me@saasmail.test",
    });

    for (const path of ["/api/sequences", `/api/sequences/${sequence.id}`]) {
      expect((await authFetch(path, { apiKey: memberApiKey })).status).toBe(
        200,
      );
    }

    const requests: Array<[string, RequestInit]> = [
      [
        "/api/sequences",
        {
          method: "POST",
          body: JSON.stringify({
            name: "Forbidden",
            steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }],
          }),
        },
      ],
      [
        `/api/sequences/${sequence.id}`,
        { method: "PUT", body: JSON.stringify({ name: "Forbidden" }) },
      ],
      [`/api/sequences/${sequence.id}`, { method: "DELETE" }],
    ];

    for (const [path, init] of requests) {
      const response = await authFetch(path, {
        apiKey: memberApiKey,
        ...init,
      });
      expect(response.status).toBe(403);
    }

    const enrollment = await authFetch(`/api/sequences/${sequence.id}/enroll`, {
      apiKey: memberApiKey,
      method: "POST",
      body: JSON.stringify({
        personId: "member-person",
        fromAddress: "me@saasmail.test",
      }),
    });
    expect(enrollment.status).toBe(201);
  });

  describe("POST /api/sequences", () => {
    it("creates a sequence", async () => {
      await createTestTemplate({ slug: "welcome" });
      const res = await authFetch("/api/sequences", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Test Sequence",
          steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }],
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("Test Sequence");
      expect(data.steps).toHaveLength(1);
    });

    it("rejects sequence with missing template", async () => {
      const res = await authFetch("/api/sequences", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Bad Sequence",
          steps: [
            { order: 1, templateSlug: "nonexistent-template", delayHours: 0 },
          ],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate step orders and unsafe delay horizons", async () => {
      await createTestTemplate({ slug: "welcome" });
      for (const steps of [
        [
          { order: 1, templateSlug: "welcome", delayHours: 0 },
          { order: 1, templateSlug: "welcome", delayHours: 1 },
        ],
        [
          {
            order: 1,
            templateSlug: "welcome",
            delayHours: Number.MAX_SAFE_INTEGER,
          },
        ],
      ]) {
        const res = await authFetch("/api/sequences", {
          apiKey,
          method: "POST",
          body: JSON.stringify({ name: "Invalid schedule", steps }),
        });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("GET /api/sequences", () => {
    it("lists sequences", async () => {
      await createSequenceWithTemplates();
      const res = await authFetch("/api/sequences", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Onboarding");
    });
  });

  describe("GET /api/sequences/:id", () => {
    it("returns sequence with parsed steps", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.steps).toHaveLength(2);
    });

    it("returns 404 for missing sequence", async () => {
      const res = await authFetch("/api/sequences/nonexistent", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/sequences/:id", () => {
    it("updates sequence name", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Updated Name");
    });

    it("validates template slugs on step update", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "PUT",
        body: JSON.stringify({
          steps: [{ order: 1, templateSlug: "nonexistent", delayHours: 0 }],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/sequences/:id", () => {
    it("deletes a sequence with no active enrollments", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("rejects deletion with active enrollments", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      // Enroll person
      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sequences/:id/enroll", () => {
    it("enrolls a person and creates scheduled emails", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
          variables: { customVar: "value" },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.enrollment.status).toBe("active");
      expect(data.scheduledEmails).toHaveLength(2);
      expect(data.scheduledEmails[0].status).toBe("queued");
    });

    it("schedules stored steps by order even when the input array is unsorted", async () => {
      await createTestTemplate({ slug: "welcome" });
      await createTestTemplate({ slug: "follow-up" });
      const create = await authFetch("/api/sequences", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Unsorted",
          steps: [
            { order: 2, templateSlug: "follow-up", delayHours: 24 },
            { order: 1, templateSlug: "welcome", delayHours: 0 },
          ],
        }),
      });
      expect(create.status).toBe(201);
      const sequence = await create.json();
      await createTestPerson({ id: "sorted-person", email: "sorted@test.com" });
      const enrolled = await authFetch(`/api/sequences/${sequence.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "sorted-person",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(enrolled.status).toBe(201);
      const data = await enrolled.json();
      expect(data.scheduledEmails.map((email: any) => email.stepOrder)).toEqual(
        [1, 2],
      );
    });

    it("rejects enrollment for nonexistent person", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "nonexistent",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects duplicate enrollment for same person", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("allows only one concurrent active enrollment per person", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      const enroll = () =>
        authFetch(`/api/sequences/${seq.id}/enroll`, {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            personId: "s1",
            fromAddress: "me@saasmail.test",
          }),
        });

      const responses = await Promise.all([enroll(), enroll()]);
      expect(responses.map((res) => res.status).sort()).toEqual([201, 400]);
      const db = getDb();
      expect(await db.select().from(sequenceEnrollments)).toHaveLength(1);
      expect(await db.select().from(sequenceEmails)).toHaveLength(2);
    });

    it("supports skipSteps", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
          skipSteps: [2],
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.scheduledEmails).toHaveLength(1);
      expect(data.scheduledEmails[0].stepOrder).toBe(1);
    });

    it("rejects if all steps skipped", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
          skipSteps: [1, 2],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("enrolls by personEmail with existing person", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personEmail: "a@test.com",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.enrollment.personId).toBe("s1");
    });

    it("enrolls by personEmail and creates person if not found", async () => {
      const seq = await createSequenceWithTemplates();

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personEmail: "new-person@test.com",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.enrollment.personId).toBeTruthy();

      // Verify person was created in DB
      const db = getDb();
      const { people } = await import("../db/people.schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(people)
        .where(eq(people.email, "new-person@test.com"));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(data.enrollment.personId);
    });

    it("canonicalizes person and sender casing before enrollment", async () => {
      const seq = await createSequenceWithTemplates();
      const first = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personEmail: "Case@Example.COM",
          fromAddress: "ME@SAASMAIL.TEST",
        }),
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.enrollment.fromAddress).toBe("me@saasmail.test");

      const second = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personEmail: "case@example.com",
          fromAddress: "me@saasmail.test",
        }),
      });
      expect(second.status).toBe(400);
    });

    it("rejects when neither personId nor personEmail provided", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ fromAddress: "me@saasmail.test" }),
      });
      expect(res.status).toBe(400);
    });

    it("supports delayOverrides", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
          delayOverrides: { "2": 48 },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      // Step 2 should have ~48 hours delay from step 1
      // Step 1 is scheduled at `now`, step 2 at `snapToNextHour(now) + 48*3600`
      // so the diff can be up to 3600s more than 48h depending on snap
      const step2 = data.scheduledEmails.find((e: any) => e.stepOrder === 2);
      const step1 = data.scheduledEmails.find((e: any) => e.stepOrder === 1);
      const diff = step2.scheduledAt - step1.scheduledAt;
      expect(diff).toBeGreaterThanOrEqual(48 * 3600);
      expect(diff).toBeLessThanOrEqual(48 * 3600 + 3600);
    });
  });

  describe("GET /api/sequences/people/:personId/enrollment", () => {
    it("returns null when no active enrollment", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      const res = await authFetch("/api/sequences/people/s1/enrollment", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enrollment).toBeNull();
      expect(data.scheduledEmails).toEqual([]);
    });

    it("returns active enrollment with scheduled emails", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });

      const res = await authFetch("/api/sequences/people/s1/enrollment", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enrollment).not.toBeNull();
      expect(data.sequenceName).toBe("Onboarding");
      expect(data.scheduledEmails).toHaveLength(2);
    });
  });

  describe("DELETE /api/sequences/enrollments/:enrollmentId", () => {
    it("cancels an active enrollment", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const enrollRes = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });
      const enrollData = await enrollRes.json();

      const res = await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );
      expect(res.status).toBe(200);

      // Verify emails were cancelled
      const db = getDb();
      const emailRows = await db
        .select()
        .from(sequenceEmails)
        .where(eq(sequenceEmails.enrollmentId, enrollData.enrollment.id));
      for (const row of emailRows) {
        expect(row.status).toBe("cancelled");
      }
    });

    it("returns 404 for nonexistent enrollment", async () => {
      const res = await authFetch("/api/sequences/enrollments/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("rejects cancellation of non-active enrollment", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com" });

      const enrollRes = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });
      const enrollData = await enrollRes.json();

      // Cancel once
      await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );

      // Try cancelling again
      const res = await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sequences/:id/enrollments", () => {
    it("lists enrollments with person info and step counts", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com", name: "Alice" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}/enrollments`, {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].personEmail).toBe("a@test.com");
      expect(data[0].personName).toBe("Alice");
      expect(data[0].totalSteps).toBe(2);
      expect(data[0].sentSteps).toBe(0);
    });

    it("counts 'suppressed' rows toward sentSteps (terminal state)", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestPerson({ id: "s1", email: "a@test.com", name: "Alice" });

      const enrollRes = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "s1",
          fromAddress: "me@saasmail.test",
        }),
      });
      const enrollData = await enrollRes.json();

      // Manually mark one of the scheduled emails as suppressed (simulating
      // what processSequenceEmail would do when the recipient is on the list).
      const db = getDb();
      const rows = await db
        .select()
        .from(sequenceEmails)
        .where(eq(sequenceEmails.enrollmentId, enrollData.enrollment.id));
      // Pick the first step deterministically by stepOrder.
      const first = rows.sort((a, b) => a.stepOrder - b.stepOrder)[0];
      await db
        .update(sequenceEmails)
        .set({ status: "suppressed" })
        .where(eq(sequenceEmails.id, first.id));

      const res = await authFetch(`/api/sequences/${seq.id}/enrollments`, {
        apiKey,
      });
      const data = await res.json();
      expect(data[0].totalSteps).toBe(2);
      expect(data[0].sentSteps).toBe(1);
    });
  });
});
