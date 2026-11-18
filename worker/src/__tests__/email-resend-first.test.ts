import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CloudflareSender,
  ResendFirstSender,
  createEmailSender,
  createEmailSenderForProvider,
  type EmailSender,
  type SendEmailParams,
  type SendEmailResult,
} from "../lib/email-sender";
import { sendViaOutbox } from "../lib/outbox";
import { outboxEmails } from "../db/outbox-emails.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";

// `cloudflare` identities go through Resend first and keep the binding as the
// reserve whenever RESEND_API_KEY is configured: a mailbox provider that
// throttles Cloudflare Email Sending's shared IPs (451 4.7.650) still gets the
// mail.

const OK: SendEmailResult = { id: "prov-1", error: null };
const REFUSED: SendEmailResult = {
  id: null,
  error: { message: "rate_limit_exceeded", transient: true },
};

function fakeSender(
  results: SendEmailResult[] | (() => never),
  provider: EmailSender["provider"],
  maxBytes = 25 * 1024 * 1024,
): EmailSender & { calls: SendEmailParams[] } {
  const calls: SendEmailParams[] = [];
  return {
    provider,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      if (typeof results === "function") return results();
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => maxBytes,
  };
}

const params: SendEmailParams = {
  from: '"Ana (via support@acme.test)" <support@acme.test>',
  to: "someone@example.com",
  subject: "Pedido 123",
  html: "<p>oi</p>",
  text: "oi",
  headers: { "Reply-To": "reply+abc@acme.test", "X-Trace": "1" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResendFirstSender", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("delivers through Resend and leaves the binding untouched", async () => {
    const resend = fakeSender([OK], "resend");
    const cloudflare = fakeSender([OK], "cloudflare");
    const result = await new ResendFirstSender(resend, cloudflare).send(params);
    expect(result).toEqual(OK);
    expect(resend.calls).toEqual([params]);
    expect(cloudflare.calls).toHaveLength(0);
  });

  it("falls back to Cloudflare with the same params when Resend refuses", async () => {
    const resend = fakeSender([REFUSED], "resend");
    const cloudflare = fakeSender([{ id: "cf-1", error: null }], "cloudflare");
    const result = await new ResendFirstSender(resend, cloudflare).send(params);
    expect(result).toEqual({ id: "cf-1", error: null });
    expect(cloudflare.calls).toEqual([params]);
  });

  it("falls back to Cloudflare when Resend throws", async () => {
    const resend = fakeSender(() => {
      throw new Error("network");
    }, "resend");
    const cloudflare = fakeSender([OK], "cloudflare");
    await new ResendFirstSender(resend, cloudflare).send(params);
    expect(cloudflare.calls).toHaveLength(1);
  });

  it("returns the Cloudflare error when both transports refuse", async () => {
    const cfError: SendEmailResult = {
      id: null,
      error: { message: "451 4.7.650", transient: true },
    };
    const result = await new ResendFirstSender(
      fakeSender([REFUSED], "resend"),
      fakeSender([cfError], "cloudflare"),
    ).send(params);
    expect(result).toEqual(cfError);
  });

  it("sends single-envelope units straight to Cloudflare", async () => {
    const resend = fakeSender([OK], "resend");
    const cloudflare = fakeSender([OK], "cloudflare");
    await new ResendFirstSender(resend, cloudflare).send({
      ...params,
      envelopeTo: "cc@example.com",
    });
    expect(resend.calls).toHaveLength(0);
    expect(cloudflare.calls).toHaveLength(1);
  });

  it("keeps Cloudflare retry semantics and the strictest attachment limit", () => {
    const sender = new ResendFirstSender(
      fakeSender([OK], "resend", 25 * 1024 * 1024),
      fakeSender([OK], "cloudflare", 18 * 1024 * 1024),
    );
    expect(sender.provider).toBe("cloudflare");
    expect(sender.maxAttachmentBytes()).toBe(18 * 1024 * 1024);
  });
});

describe("identity routing with Resend first", () => {
  function routedEnv(
    provider: "cloudflare" | "resend",
    extra: Record<string, unknown> = {},
  ) {
    const binding = { send: vi.fn().mockResolvedValue({ messageId: "cf-1" }) };
    const e = {
      EMAIL_PROVIDER_ROUTING: "identity",
      RESEND_API_KEY: "re_test",
      EMAIL: binding,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ outbound_provider: provider }),
          }),
        }),
      },
      ...extra,
    } as unknown as CloudflareBindings;
    return { env: e, binding };
  }

  function stubResend(response: () => Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return response();
      }),
    );
    return calls;
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends a cloudflare identity through the Resend API with the original From", async () => {
    const calls = stubResend(
      async () => new Response('{"id":"re-1"}', { status: 200 }),
    );
    const { env: e, binding } = routedEnv("cloudflare");
    const result = await createEmailSender(e).send({
      ...params,
      cc: ["Copy <cc@example.com>"],
      attachments: [
        {
          filename: "a.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("hello"),
        },
      ],
      idempotencyKey: "unit-1",
    });

    expect(result).toEqual({ id: "re-1", error: null });
    expect(binding.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer re_test");
    expect(headers.get("Idempotency-Key")).toBe("unit-1");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      // The forward's "Name (via alias@domain)" display name stays intact.
      from: '"Ana (via support@acme.test)" <support@acme.test>',
      to: "someone@example.com",
      cc: ["Copy <cc@example.com>"],
      reply_to: "reply+abc@acme.test",
      subject: "Pedido 123",
      html: "<p>oi</p>",
      text: "oi",
      headers: { "X-Trace": "1" },
      attachments: [{ filename: "a.txt", content: "aGVsbG8=" }],
    });
    expect(body.headers["Reply-To"]).toBeUndefined();
  });

  for (const [label, response] of [
    [
      "429",
      async () =>
        new Response(
          '{"name":"rate_limit_exceeded","message":"Too many requests","statusCode":429}',
          { status: 429 },
        ),
    ],
    ["503", async () => new Response("upstream down", { status: 503 })],
    [
      "403 unverified domain",
      async () =>
        new Response(
          '{"name":"validation_error","message":"The acme.test domain is not verified","statusCode":403}',
          { status: 403 },
        ),
    ],
    [
      "a thrown fetch",
      async () => {
        throw new Error("network");
      },
    ],
  ] as const) {
    it(`falls back to the Cloudflare binding on ${label}`, async () => {
      stubResend(response);
      const { env: e, binding } = routedEnv("cloudflare");
      const result = await createEmailSender(e).send(params);
      expect(result).toEqual({ id: "cf-1", error: null });
      expect(binding.send).toHaveBeenCalledTimes(1);
    });
  }

  it("without RESEND_API_KEY keeps the plain binding and never calls Resend", async () => {
    const calls = stubResend(async () => new Response("{}", { status: 200 }));
    const { env: e, binding } = routedEnv("cloudflare", {
      RESEND_API_KEY: undefined,
    });
    const result = await createEmailSender(e).send(params);
    expect(result).toEqual({ id: "cf-1", error: null });
    expect(calls).toHaveLength(0);
    expect(binding.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a resend identity Resend-only (no silent Cloudflare fallback)", async () => {
    stubResend(async () => new Response('{"message":"boom"}', { status: 500 }));
    const { env: e, binding } = routedEnv("resend");
    const result = await createEmailSender(e).send(params);
    expect(result.error).not.toBeNull();
    expect(binding.send).not.toHaveBeenCalled();
  });

  it("still fails closed for a cloudflare identity without the binding", async () => {
    const calls = stubResend(async () => new Response("{}", { status: 200 }));
    const { env: e } = routedEnv("cloudflare", { EMAIL: undefined });
    const result = await createEmailSender(e).send(params);
    expect(result.error?.message).toMatch(/EMAIL binding is not configured/);
    expect(calls).toHaveLength(0);
  });

  it("recreates Resend-first for snapshotted cloudflare outbox units", () => {
    const binding = { send: vi.fn() } as unknown as SendEmail;
    expect(
      createEmailSenderForProvider(
        {
          RESEND_API_KEY: "re_test",
          EMAIL: binding,
        } as unknown as CloudflareBindings,
        "cloudflare",
      ),
    ).toBeInstanceOf(ResendFirstSender);
    expect(
      createEmailSenderForProvider(
        { EMAIL: binding } as unknown as CloudflareBindings,
        "cloudflare",
      ),
    ).toBeInstanceOf(CloudflareSender);
  });
});

describe("outbox with Resend first", () => {
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function outboxParams(sender: EmailSender) {
    return {
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-rf",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      cc: [{ email: "cc@example.com", name: "Copy Recipient" }],
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-rf@saasmail.test>" },
      transactional: true,
    };
  }

  it("keeps transactional To + Cc as one unit delivered by one Resend call", async () => {
    const resend = fakeSender([OK], "resend");
    const cloudflare = fakeSender([OK], "cloudflare");
    const result = await sendViaOutbox(
      outboxParams(new ResendFirstSender(resend, cloudflare)),
    );

    expect(result.outcome).toBe("sent");
    expect(result.send.delivered).toEqual(["to@example.com", "cc@example.com"]);
    expect(resend.calls).toHaveLength(1);
    expect(resend.calls[0].to).toBe("to@example.com");
    expect(resend.calls[0].cc).toEqual(["Copy Recipient <cc@example.com>"]);
    expect(resend.calls[0].envelopeTo).toBeUndefined();
    expect(cloudflare.calls).toHaveLength(0);
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("cloudflare");
  });

  it("hands the same single unit to the Cloudflare reserve when Resend refuses", async () => {
    const resend = fakeSender([REFUSED], "resend");
    const cloudflare = fakeSender([OK], "cloudflare");
    const result = await sendViaOutbox(
      outboxParams(new ResendFirstSender(resend, cloudflare)),
    );

    expect(result.outcome).toBe("sent");
    expect(cloudflare.calls).toHaveLength(1);
    expect(cloudflare.calls[0].cc).toEqual(["Copy Recipient <cc@example.com>"]);
    expect(cloudflare.calls[0].envelopeTo).toBeUndefined();
  });
});
