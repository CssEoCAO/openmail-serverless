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

    it("separates who can SEND from who RECEIVES", async () => {
      // A catch-all address that receives but was never configured to send: it owns no
      // sender_identities row, so it has no outbound_provider. Offering it in a "From"
      // picker makes the send fall through to the default provider and fail in the
      // user's face — that is exactly what happened to contact@example.com on
      // 23/08/2026, after these two lists were briefly merged into one.
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "received-only@saasmail.test",
      });
      // And a configured identity that has no received mail yet.
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(senderIdentities).values({
        email: "created-only@saasmail.test",
        displayName: "Fresh",
        createdAt: now,
        updatedAt: now,
      });

      const res = await authFetch("/api/stats", { apiKey });
      const data = await res.json();

      // Sending: only the configured identity.
      expect(data.recipients).toEqual(["created-only@saasmail.test"]);
      expect(
        data.senderIdentities.map((s: { email: string }) => s.email),
      ).toEqual(["created-only@saasmail.test"]);

      // Receiving: both, configured first so the compose default stays sendable.
      expect(data.inboxes.map((i: { email: string }) => i.email)).toEqual([
        "created-only@saasmail.test",
        "received-only@saasmail.test",
      ]);
      expect(
        data.inboxes.find(
          (i: { email: string }) => i.email === "received-only@saasmail.test",
        ),
      ).toEqual({
        email: "received-only@saasmail.test",
        displayName: null,
        podeEnviar: false,
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
