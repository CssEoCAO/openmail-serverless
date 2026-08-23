import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail, MAX_RAW_EMAIL_BYTES } from "../email-handler";
import { MAX_D1_EMAIL_TEXT_BYTES } from "../lib/email-limits";
import { emails } from "../db/emails.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  getDb,
} from "./helpers";

function inboundMessage(raw: string, to = "support@example.com") {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "sender@example.com",
    to,
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as any;
}

function executionContext(waiters: Promise<unknown>[]) {
  return {
    waitUntil(promise: Promise<unknown>) {
      waiters.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as any;
}

describe("inbound email resource limits", () => {
  it("rejects oversized raw messages before parsing or touching storage", async () => {
    const setReject = vi.fn();
    const message = {
      from: "sender@example.com",
      to: "inbox@example.com",
      headers: new Headers(),
      raw: new ReadableStream(),
      rawSize: MAX_RAW_EMAIL_BYTES + 1,
      setReject,
      forward: vi.fn(),
      reply: vi.fn(),
    } as any;

    await handleEmail(message, {} as any, {} as any);

    expect(setReject).toHaveBeenCalledWith("Message too large");
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("rejects parsed text that cannot fit in one D1 row", async () => {
    await applyMigrations();
    await cleanDb();
    const body = "x".repeat(MAX_D1_EMAIL_TEXT_BYTES + 1);
    const raw = [
      "From: Sender <sender@example.com>",
      "To: support@example.com",
      "Subject: Too large for D1",
      "Message-ID: <too-large@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\r\n");
    const message = inboundMessage(raw);

    await handleEmail(
      message,
      env as unknown as CloudflareBindings,
      executionContext([]),
    );

    expect(message.setReject).toHaveBeenCalledWith("Message content too large");
    expect(await getDb().select().from(emails)).toHaveLength(0);
    expect(await getDb().select().from(people)).toHaveLength(0);
  });
});

describe("inbound email idempotency", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("atomically deduplicates concurrent Message-ID delivery", async () => {
    const raw = [
      "From: Sender <sender@example.com>",
      "To: support@example.com",
      "Subject: Duplicate delivery",
      "Message-ID: <same-message@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello",
    ].join("\r\n");
    const waiters: Promise<unknown>[] = [];

    await Promise.all([
      handleEmail(
        inboundMessage(raw),
        env as unknown as CloudflareBindings,
        executionContext(waiters),
      ),
      handleEmail(
        inboundMessage(raw),
        env as unknown as CloudflareBindings,
        executionContext(waiters),
      ),
    ]);
    await Promise.allSettled(waiters);

    expect(await getDb().select().from(emails)).toHaveLength(1);
    const rows = await getDb().select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0].unreadCount).toBe(1);
    expect(rows[0].totalCount).toBe(1);
  });

  it("preserves the same RFC message when routed to two owned inboxes", async () => {
    const raw = [
      "From: Sender <sender@example.com>",
      "To: support-a@example.com, support-b@example.com",
      "Subject: Shared delivery",
      "Message-ID: <shared-message@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello both inboxes",
    ].join("\r\n");

    await handleEmail(
      inboundMessage(raw, "support-a@example.com"),
      env as unknown as CloudflareBindings,
      executionContext([]),
    );
    await handleEmail(
      inboundMessage(raw, "support-b@example.com"),
      env as unknown as CloudflareBindings,
      executionContext([]),
    );

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.recipient).sort()).toEqual([
      "support-a@example.com",
      "support-b@example.com",
    ]);
  });

  it("commits attachment metadata with the email after the R2 upload", async () => {
    const raw = [
      "From: Sender <sender@example.com>",
      "To: support@example.com",
      "Subject: Attachment",
      "Message-ID: <attachment-message@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="audit-boundary"',
      "",
      "--audit-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attachment",
      "--audit-boundary",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="../evidence.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "aGVsbG8=",
      "--audit-boundary--",
      "",
    ].join("\r\n");
    const waiters: Promise<unknown>[] = [];

    await handleEmail(
      inboundMessage(raw),
      env as unknown as CloudflareBindings,
      executionContext(waiters),
    );
    await Promise.allSettled(waiters);

    const rows = await getDb().select().from(attachments);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("evidence.txt");
    const object = await env.R2.get(rows[0].r2Key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe("hello");
  });

  it("does not let a spoofed duplicate Message-ID cancel another sender's sequence", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "victim", email: "victim@example.com" });
    await createTestEmail({
      id: "known-email",
      personId: "victim",
      recipient: "support@example.com",
      messageId: "<known-message@example.com>",
    });
    await db.insert(sequences).values({
      id: "seq-victim",
      name: "Victim sequence",
      steps: "[]",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enrollment-victim",
      sequenceId: "seq-victim",
      personId: "victim",
      status: "active",
      variables: "{}",
      fromAddress: "support@example.com",
      enrolledAt: now,
    });

    const duplicateRaw = (from: string, authentication?: string) =>
      [
        `From: ${from}`,
        "To: support@example.com",
        "Subject: Duplicate",
        "Message-ID: <known-message@example.com>",
        ...(authentication
          ? [`Authentication-Results: ${authentication}`]
          : []),
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello",
      ].join("\r\n");

    await handleEmail(
      inboundMessage(duplicateRaw("attacker@example.com")),
      env as unknown as CloudflareBindings,
      executionContext([]),
    );
    let enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enrollment-victim"));
    expect(enrollment[0].status).toBe("active");

    await handleEmail(
      inboundMessage(
        duplicateRaw(
          "victim@example.com",
          "mx.cloudflare.net; dmarc=pass header.from=example.com",
        ),
      ),
      env as unknown as CloudflareBindings,
      executionContext([]),
    );
    enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enrollment-victim"));
    expect(enrollment[0].status).toBe("cancelled");
  });

  it("stores but does not mutate automation for an unauthenticated forged From", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({
      id: "forged-victim",
      email: "victim@example.com",
    });
    await db.insert(sequences).values({
      id: "seq-forged-victim",
      name: "Victim sequence",
      steps: "[]",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enrollment-forged-victim",
      sequenceId: "seq-forged-victim",
      personId: "forged-victim",
      status: "active",
      variables: "{}",
      fromAddress: "support@example.com",
      enrolledAt: now,
    });

    const raw = [
      "From: Forged Name <victim@example.com>",
      "To: support@example.com",
      "Subject: Spoof",
      "Message-ID: <fresh-spoof@example.com>",
      "Authentication-Results: attacker.example; spf=pass; dkim=pass; dmarc=pass header.from=example.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Not really the victim",
    ].join("\r\n");

    await handleEmail(
      inboundMessage(raw),
      env as unknown as CloudflareBindings,
      executionContext([]),
    );

    const enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enrollment-forged-victim"));
    expect(enrollment[0].status).toBe("active");
    const person = await db
      .select()
      .from(people)
      .where(eq(people.id, "forged-victim"));
    expect(person[0].name).not.toBe("Forged Name");
  });
});
