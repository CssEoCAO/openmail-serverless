import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { env } from "cloudflare:workers";
import { attemptOutboxRow, sendViaOutbox } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { suppressions } from "../db/suppressions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";

describe("outbox_emails table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("round-trips an outbox row", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(outboxEmails).values({
      id: "ob-1",
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 0,
      status: "pending",
      attempts: 1,
      lastError: "quota exceeded",
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, "ob-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sequenceEmailId).toBeNull();
  });
});

/** Fake sender whose result is scripted per call. */
function fakeSender(
  results: SendEmailResult[],
  provider: EmailSender["provider"] = "none",
): EmailSender & {
  calls: SendEmailParams[];
} {
  const calls: SendEmailParams[] = [];
  return {
    provider,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
}

const OK: SendEmailResult = { id: "prov-1", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};
const PERMANENT: SendEmailResult = {
  id: null,
  error: { message: "invalid recipient", transient: false },
};

describe("sendViaOutbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  function baseParams(sender: EmailSender) {
    return {
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-1@saasmail.test>" },
      transactional: true,
    };
  }

  it("keeps a sent marker until the caller commits permanent history", async () => {
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("sent");
    expect(result.send.result?.id).toBe("prov-1");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  it("keeps a pending row with attempts=1 on transient failure", async () => {
    const sender = fakeSender([TRANSIENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("retrying");
    expect(result.send.delivered).toEqual([]);
    expect(result.send.attempted).toEqual(["to@example.com"]);
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBe("quota exceeded");
    expect(rows[0].sentEmailId).toBe("se-1");
    expect(rows[0].nextRetryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(rows[0].nextRetryAt).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 60,
    );
    expect(JSON.parse(rows[0].headers!)["Message-ID"]).toBe(
      "<mid-1@saasmail.test>",
    );
  });

  it("marks the row failed on permanent failure", async () => {
    const sender = fakeSender([PERMANENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("failed");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(1);
  });

  it("preserves the write-ahead row when transport acceptance is ambiguous", async () => {
    const throwingSender: EmailSender = {
      provider: "resend",
      async send() {
        throw new Error("unexpected transport crash");
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };
    await expect(sendViaOutbox(baseParams(throwingSender))).rejects.toThrow(
      "unexpected transport crash",
    );
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].wireTo).toBe("to@example.com");
  });

  it("holds ambiguous non-idempotent provider delivery for manual review", async () => {
    const throwingSender: EmailSender = {
      provider: "cloudflare",
      async send() {
        throw new Error("response lost after submission");
      },
      maxAttachmentBytes: () => 10 * 1024 * 1024,
    };
    const result = await sendViaOutbox(baseParams(throwingSender));
    expect(result.outcome).toBe("failed");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toContain("manual review required");
  });

  it("keeps the write-ahead row unclaimable while the inline attempt is in flight", async () => {
    let observedNextRetryAt: number | null | undefined;
    const observingSender: EmailSender = {
      provider: "none",
      async send() {
        const rows = await getDb().select().from(outboxEmails);
        observedNextRetryAt = rows[0]?.nextRetryAt;
        return { id: "prov-1", error: null };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };
    await sendViaOutbox(baseParams(observingSender));
    expect(observedNextRetryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("deletes the row when every recipient is suppressed", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(suppressions).values({
      id: "sup-1",
      email: "to@example.com",
      reason: "unsubscribe",
      createdAt: now,
    });
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox({
      ...baseParams(sender),
      transactional: false, // suppression only applies to marketing sends
    });
    expect(result.outcome).toBe("suppressed");
    expect(sender.calls).toHaveLength(0);
    const rows = await db.select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });

  it("retries only the failed marketing recipient with the frozen wire payload", async () => {
    const db = getDb();
    const sender = fakeSender([OK, TRANSIENT]);
    const result = await sendViaOutbox({
      ...baseParams(sender),
      transactional: false,
      cc: [{ email: "cc@example.com", name: "Copy Recipient" }],
      html: "<p>Hello {{unsubscribe_url}}</p>",
    });
    expect(result.outcome).toBe("retrying");
    expect(result.send.delivered).toEqual(["to@example.com"]);
    expect(result.send.attempted).toEqual(["to@example.com", "cc@example.com"]);
    const rows = await db.select().from(outboxEmails);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["pending", "sent"]);
    const pending = rows.find((row) => row.status === "pending")!;
    expect(pending.toAddress).toBe("cc@example.com");
    expect(pending.wireTo).toBe("Copy Recipient <cc@example.com>");
    expect(pending.bodyHtml).not.toContain("{{unsubscribe_url}}");

    await db
      .update(outboxEmails)
      .set({ nextRetryAt: Math.floor(Date.now() / 1000) - 1 })
      .where(eq(outboxEmails.id, pending.id));
    const retrySender = fakeSender([OK]);
    expect(
      await attemptOutboxRow(
        db,
        env as unknown as CloudflareBindings,
        retrySender,
        pending.id,
      ),
    ).toBe("sent");
    expect(retrySender.calls).toHaveLength(1);
    expect(retrySender.calls[0].to).toBe(pending.wireTo);
    expect(retrySender.calls[0].html).toBe(pending.bodyHtml);
    expect(retrySender.calls[0].idempotencyKey).toBe(pending.id);
    expect(await db.select().from(outboxEmails)).toHaveLength(0);
    const history = await db.select().from(sentEmails);
    expect(history).toHaveLength(1);
    expect(history[0].toAddress).toBe("to@example.com");
    expect(history[0].personId).not.toBeNull();
    expect(history[0].conversationId).toMatch(/^c_/);
    expect(
      await db.select().from(people).where(eq(people.id, history[0].personId!)),
    ).toMatchObject([{ email: "to@example.com" }]);
  });

  it("fences Cloudflare transactional recipients independently while preserving visible Cc", async () => {
    const db = getDb();
    const sender = fakeSender([OK, TRANSIENT], "cloudflare");
    const result = await sendViaOutbox({
      ...baseParams(sender),
      cc: [{ email: "cc@example.com", name: "Copy Recipient" }],
    });

    expect(result.outcome).toBe("retrying");
    expect(result.send.delivered).toEqual(["to@example.com"]);
    expect(result.send.attempted).toEqual(["to@example.com", "cc@example.com"]);
    expect(sender.calls).toHaveLength(2);
    expect(sender.calls.map((call) => call.envelopeTo)).toEqual([
      "to@example.com",
      "cc@example.com",
    ]);
    for (const call of sender.calls) {
      expect(call.to).toBe("to@example.com");
      expect(call.cc).toEqual(["Copy Recipient <cc@example.com>"]);
    }

    const rows = await db.select().from(outboxEmails);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["pending", "sent"]);
    const pending = rows.find((row) => row.status === "pending")!;
    expect(pending.toAddress).toBe("cc@example.com");

    await db
      .update(outboxEmails)
      .set({ nextRetryAt: Math.floor(Date.now() / 1000) - 1 })
      .where(eq(outboxEmails.id, pending.id));
    const retrySender = fakeSender([OK], "cloudflare");
    expect(
      await attemptOutboxRow(
        db,
        env as unknown as CloudflareBindings,
        retrySender,
        pending.id,
      ),
    ).toBe("sent");
    expect(retrySender.calls).toHaveLength(1);
    expect(retrySender.calls[0].envelopeTo).toBe("cc@example.com");
    expect(retrySender.calls[0].to).toBe("to@example.com");
    expect(retrySender.calls[0].cc).toEqual([
      "Copy Recipient <cc@example.com>",
    ]);
    expect(await db.select().from(outboxEmails)).toHaveLength(0);
  });
});
