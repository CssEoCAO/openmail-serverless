import { env } from "cloudflare:workers";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleEmail } from "../email-handler";
import {
  CloudflareSender,
  ResendSender,
  createEmailSender,
} from "../lib/email-sender";
import { attemptOutboxRow } from "../lib/outbox";
import { eq } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { emails } from "../db/emails.schema";
import { appSettings } from "../db/app-settings.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";

const bindings = {
  ...env,
  EMAIL: {} as SendEmail,
  EMAIL_PROVIDER_ROUTING: "identity",
} as unknown as CloudflareBindings;
const inbox = "support@acme.test";
const personal = "owner@gmail.com";

async function receive(
  to: string,
  from: string,
  id: string | null,
  extra: string[] = [],
  body = "Resposta pelo celular.\n\n> Original message",
) {
  const bytes = new TextEncoder().encode(
    [
      `From: ${from}`,
      `To: ${to}`,
      "Subject: Help with my order",
      ...(id ? [`Message-ID: <${id}@example.com>`] : []),
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${from.split("@")[1]}`,
      ...extra,
      ...(extra.some((header) => /^content-type:/i.test(header))
        ? []
        : ["Content-Type: text/plain; charset=utf-8"]),
      "",
      body,
    ].join("\r\n"),
  );
  const message = {
    from,
    to,
    rawSize: bytes.length,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  const waiters: Promise<unknown>[] = [];
  await handleEmail(message, bindings, {
    waitUntil: (promise: Promise<unknown>) => waiters.push(promise),
  } as unknown as ExecutionContext);
  await Promise.all(waiters);
  return message;
}

async function startForward(headers: string[] = []) {
  const send = vi
    .spyOn(CloudflareSender.prototype, "send")
    .mockResolvedValue({ id: "provider-id", error: null });
  await receive(inbox, "customer@example.com", "original", headers);
  const replyAddress = send.mock.calls[0][0].headers!["Reply-To"];
  send.mockClear();
  return { send, replyAddress };
}

const attachmentBody = [
  "--test",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Segue anexo.",
  "--test",
  "Content-Type: text/plain",
  'Content-Disposition: attachment; filename="../recibo.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8=",
  "--test--",
].join("\r\n");
const attachmentHeaders = ['Content-Type: multipart/mixed; boundary="test"'];

describe("replying to a forwarded message", () => {
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    await getDb().insert(senderIdentities).values({
      email: inbox,
      displayName: "Acme",
      outboundProvider: "cloudflare",
      forwardTo: personal,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the personal reply as the original inbox and records it once in the same conversation", async () => {
    const send = vi
      .spyOn(CloudflareSender.prototype, "send")
      .mockResolvedValue({ id: "provider-id", error: null });
    await receive(inbox, "customer@example.com", "original");
    const forward = send.mock.calls[0][0];
    const replyAddress = forward.headers!["Reply-To"];
    expect(replyAddress).toMatch(/^reply\+[^@]+@acme\.test$/);
    expect(replyAddress.split("@")[0].length).toBeLessThanOrEqual(64);
    send.mockClear();

    await Promise.all([
      receive(replyAddress, personal, "personal-reply"),
      receive(replyAddress, personal, "personal-reply"),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const reply = send.mock.calls[0][0];
    expect(reply.from).toBe("Acme <support@acme.test>");
    expect(reply.to).toBe("customer@example.com");
    expect(reply.text).toBe("Resposta pelo celular.");
    expect(reply.headers).toMatchObject({
      "In-Reply-To": "<original@example.com>",
      References: "<original@example.com>",
    });
    expect(JSON.stringify(reply)).not.toContain(personal);
    const history = await getDb().select().from(sentEmails);
    const originals = await getDb().select().from(emails);
    expect(originals).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      personId: originals[0].personId,
      fromAddress: inbox,
      conversationId: originals[0].conversationId,
      status: "sent",
    });
    await receive(replyAddress, personal, "personal-reply");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    "different sender",
    "forged From",
    "tampered token",
    "wrong domain",
    "unknown conversation",
    "automatic reply",
    "forwarding loop",
    "missing message id",
    "empty body",
  ])(
    "rejects %s without sending or creating a new conversation",
    async (reason) => {
      const { send, replyAddress } = await startForward();
      const address =
        reason === "tampered token"
          ? replyAddress.replace(
              /\.([a-f0-9])/,
              (_, digit) => `.${digit === "a" ? "b" : "a"}`,
            )
          : reason === "wrong domain"
            ? replyAddress.replace("acme.test", "other.test")
            : reason === "unknown conversation"
              ? replyAddress.replace(/reply\+[^.]+/, `reply+${"x".repeat(21)}`)
              : replyAddress;
      const message = await receive(
        address,
        reason === "different sender" ? "stranger@gmail.com" : personal,
        reason === "missing message id" ? null : "reply",
        reason === "forged From"
          ? [
              "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=gmail.com",
            ]
          : reason === "automatic reply"
            ? ["Auto-Submitted: auto-replied"]
            : reason === "forwarding loop"
              ? ["X-SaaSMail-Forwarded-For: support@acme.test"]
              : [],
        reason === "empty body" ? "" : "Resposta.",
      );
      expect(message.setReject).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await getDb().select().from(sentEmails)).toHaveLength(0);
      expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
      expect(await getDb().select().from(emails)).toHaveLength(1);
    },
  );

  it.each([null, "new-owner@gmail.com"])(
    "revokes old reply aliases when forwarding becomes %s",
    async (forwardTo) => {
      const { send, replyAddress } = await startForward();
      await getDb()
        .update(senderIdentities)
        .set({ forwardTo })
        .where(eq(senderIdentities.email, inbox));
      const message = await receive(replyAddress, personal, "reply");
      expect(message.setReject).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("uses the stored Reply-To and conversation, ignoring personal recipient overrides", async () => {
    const { send, replyAddress } = await startForward([
      'Reply-To: "Customer" <submitter@example.com>',
      "Cc: colleague@example.com",
    ]);
    await receive(replyAddress, personal, "reply", [
      "Cc: stranger@example.com",
      "Reply-To: attacker@example.com",
    ]);
    const reply = send.mock.calls[0][0];
    expect(reply.to).toBe("submitter@example.com");
    expect(reply.cc).toBeUndefined();
    expect(reply.headers!["Reply-To"]).toBe(inbox);
    const [original] = await getDb().select().from(emails);
    const [sent] = await getDb().select().from(sentEmails);
    expect(original.conversationId).toBeTruthy();
    expect(sent.conversationId).toBe(original.conversationId);
    expect(sent.personId).toBe(original.personId);
  });

  it("preserves the Resend identity for both the forward and the personal reply", async () => {
    await getDb()
      .update(senderIdentities)
      .set({ outboundProvider: "resend" })
      .where(eq(senderIdentities.email, inbox));
    const resend = vi
      .spyOn(ResendSender.prototype, "send")
      .mockResolvedValue({ id: "resend-id", error: null });
    const cloudflare = vi.spyOn(CloudflareSender.prototype, "send");
    await receive(inbox, "customer@example.com", "original");
    await receive(
      resend.mock.calls[0][0].headers!["Reply-To"],
      personal,
      "reply",
    );
    expect(resend).toHaveBeenCalledTimes(2);
    expect(resend.mock.calls[1][0].from).toBe("Acme <support@acme.test>");
    expect(cloudflare).not.toHaveBeenCalled();
    expect((await getDb().select().from(sentEmails))[0].status).toBe("sent");
  });

  it("persists attachments once under concurrent delivery and retries through the same outbox", async () => {
    const { send, replyAddress } = await startForward();
    send.mockResolvedValueOnce({
      id: null,
      error: { message: "Quota exceeded", transient: true },
    });
    await Promise.all([
      receive(
        replyAddress,
        personal,
        "with-attachment",
        attachmentHeaders,
        attachmentBody,
      ),
      receive(
        replyAddress,
        personal,
        "with-attachment",
        attachmentHeaders,
        attachmentBody,
      ),
    ]);
    expect(send).toHaveBeenCalledOnce();
    const firstAttempt = send.mock.calls[0][0];
    expect(firstAttempt.attachments![0].filename).toBe("recibo.txt");
    const [stored] = await getDb().select().from(attachments);
    expect(await getDb().select().from(attachments)).toHaveLength(1);
    expect(await (await env.R2.get(stored.r2Key))!.text()).toBe("hello");
    expect(
      (await env.R2.list({ prefix: `attachments/sent/${stored.emailId}/` }))
        .objects,
    ).toHaveLength(1);
    const [pending] = await getDb().select().from(outboxEmails);
    expect(pending.status).toBe("pending");
    expect((await getDb().select().from(sentEmails))[0].status).toBe(
      "retrying",
    );
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 1 })
      .where(eq(outboxEmails.id, pending.id));
    await attemptOutboxRow(
      getDb(),
      bindings,
      createEmailSender(bindings),
      pending.id,
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].idempotencyKey).toBe(
      firstAttempt.idempotencyKey,
    );
    expect(
      new TextDecoder().decode(send.mock.calls[1][0].attachments![0].content),
    ).toBe("hello");
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    expect((await getDb().select().from(sentEmails))[0].status).toBe("sent");
  });

  it("rejects over-limit attachments as a whole instead of sending an incomplete reply", async () => {
    const { send, replyAddress } = await startForward();
    vi.spyOn(CloudflareSender.prototype, "maxAttachmentBytes").mockReturnValue(
      2,
    );
    const message = await receive(
      replyAddress,
      personal,
      "too-large",
      attachmentHeaders,
      attachmentBody,
    );
    expect(message.setReject).toHaveBeenCalledWith(
      "Forwarded reply attachments exceed the sending limit",
    );
    expect(send).not.toHaveBeenCalled();
    expect(await getDb().select().from(attachments)).toHaveLength(0);
  });

  it("enforces the inbox sending budget before storing attachments or queuing a reply", async () => {
    const { send, replyAddress } = await startForward();
    await getDb()
      .insert(appSettings)
      .values({
        key: `__budget:send:${inbox}:86400`,
        value: "1000",
        updatedAt: Math.floor(Date.now() / 86_400_000) * 86400,
      });
    const upload = vi.spyOn(bindings.R2, "put");
    await expect(
      receive(
        replyAddress,
        personal,
        "over-budget",
        attachmentHeaders,
        attachmentBody,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(send).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(await getDb().select().from(attachments)).toHaveLength(0);
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });

  it("relays only the authored HTML, removing Gmail attribution and forwarded content", async () => {
    const { send, replyAddress } = await startForward();
    await receive(
      replyAddress,
      personal,
      "html",
      ["Content-Type: text/html; charset=utf-8"],
      '<div dir="ltr">Resolvido!</div><div dir="ltr" class="gmail_quote gmail_quote_container"><div>Em 07/10, owner@gmail.com escreveu:</div>Forwarded by saasmail</div>',
    );
    expect(send.mock.calls[0][0].html).toBe('<div dir="ltr">Resolvido!</div>');
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain(personal);
  });

  it("relays a reply sent to the inbox itself when References names the alias", async () => {
    const { send, replyAddress } = await startForward();
    const message = await receive(inbox, personal, "reply-to-from", [
      `In-Reply-To: <provider-id@ses.example>`,
      `References: <${replyAddress}> <provider-id@ses.example>`,
    ]);
    expect(message.setReject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("customer@example.com");
    expect(await getDb().select().from(emails)).toHaveLength(1);
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
  });

  it("forwards the alias in References so replies to the From can be matched", async () => {
    const { replyAddress } = await startForward();
    expect(replyAddress).toMatch(/^reply\+/);
    const send = vi
      .spyOn(CloudflareSender.prototype, "send")
      .mockResolvedValue({ id: "provider-id", error: null });
    await receive(inbox, "customer@example.com", "second");
    const forward = send.mock.calls[0][0];
    expect(forward.headers!.References).toBe(
      `<${forward.headers!["Reply-To"]}>`,
    );
  });

  it.each(["stranger@gmail.com", "forged"])(
    "ingests a reply to the inbox as ordinary mail when the References alias does not check out (%s)",
    async (who) => {
      const { send, replyAddress } = await startForward();
      const message = await receive(
        inbox,
        who === "forged" ? personal : who,
        "not-a-relay",
        [
          `References: <${replyAddress}>`,
          ...(who === "forged"
            ? [
                "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=gmail.com",
              ]
            : []),
        ],
      );
      expect(message.setReject).not.toHaveBeenCalled();
      expect(await getDb().select().from(sentEmails)).toHaveLength(0);
      expect(await getDb().select().from(emails)).toHaveLength(2);
      expect(send.mock.calls.every((c) => c[0].to === personal)).toBe(true);
    },
  );
});
