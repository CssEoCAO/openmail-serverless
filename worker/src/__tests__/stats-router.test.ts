import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";

describe("stats router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/stats", () => {
    it("returns zero counts when empty", async () => {
      const res = await authFetch("/api/stats", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalPeople).toBe(0);
      expect(data.totalEmails).toBe(0);
      expect(data.unreadCount).toBe(0);
      expect(data.recipients).toEqual([]);
    });

    it("returns correct counts", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        isRead: 0,
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        isRead: 1,
        messageId: "msg-2@test.com",
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e3",
        personId: "s1",
        isRead: 0,
        messageId: "msg-3@test.com",
        recipient: "other@saasmail.test",
      });
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(senderIdentities)
        .values([
          {
            email: "inbox@saasmail.test",
            displayName: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            email: "other@saasmail.test",
            displayName: null,
            createdAt: now,
            updatedAt: now,
          },
        ]);

      const res = await authFetch("/api/stats", { apiKey });
      const data = await res.json();
      expect(data.totalPeople).toBe(2);
      expect(data.totalEmails).toBe(3);
      expect(data.unreadCount).toBe(2);
      expect(data.recipients).toContain("inbox@saasmail.test");
      expect(data.recipients).toContain("other@saasmail.test");
    });

    it("recipients spans received addresses and configured identities", async () => {
      // A catch-all address that has received mail but was never given
      // custom config, so it owns no sender_identities row.
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "received-only@saasmail.test",
      });
      // And a sender_identity that has no received mail yet - e.g. freshly
      // created via POST /api/admin/inboxes.
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(senderIdentities).values({
        email: "created-only@saasmail.test",
        displayName: "Fresh",
        createdAt: now,
        updatedAt: now,
      });

      const res = await authFetch("/api/stats", { apiKey });
      const data = await res.json();
      // Both, and configured first: ComposeModal defaults From to
      // recipients[0], so a bare catch-all address must not lead.
      expect(data.recipients).toEqual([
        "created-only@saasmail.test",
        "received-only@saasmail.test",
      ]);
      expect(
        data.senderIdentities.find(
          (s: { email: string }) => s.email === "received-only@saasmail.test",
        ),
      ).toEqual({
        email: "received-only@saasmail.test",
        displayName: null,
        signatureHtml: null,
      });
    });

    it("filters by recipient", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        isRead: 0,
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s1",
        isRead: 0,
        messageId: "msg-2@test.com",
        recipient: "other@saasmail.test",
      });

      const res = await authFetch(
        "/api/stats?recipient=inbox%40saasmail.test",
        {
          apiKey,
        },
      );
      const data = await res.json();
      expect(data.totalEmails).toBe(1);
      expect(data.unreadCount).toBe(1);
    });
  });
});
