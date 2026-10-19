/**
 * Forwarded copies state the real reply destination, and password sign-in
 * has an attempt budget on Workers.
 */
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
import { handleEmail } from "../email-handler";
import { CloudflareSender } from "../lib/email-sender";
import { senderIdentities } from "../db/sender-identities.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { type Credentials, createUserWithPassword, json } from "./mcp-helpers";

const bindings = {
  ...env,
  EMAIL: {} as SendEmail,
  EMAIL_PROVIDER_ROUTING: "identity",
} as unknown as CloudflareBindings;

async function receive(opts: {
  to: string;
  from: string;
  messageId: string;
  dmarc: "pass" | "fail";
  extra?: string[];
}) {
  const domain = opts.from.split("@")[1];
  const bytes = new TextEncoder().encode(
    [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      "Subject: Dados da nota",
      `Message-ID: <${opts.messageId}@example.com>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=${opts.dmarc} header.from=${domain}`,
      ...(opts.extra ?? []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Pode me mandar os dados?",
    ].join("\r\n"),
  );
  const message = {
    from: opts.from,
    to: opts.to,
    rawSize: bytes.length,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  const waiters: Promise<unknown>[] = [];
  await handleEmail(message, bindings, {
    waitUntil: (p: Promise<unknown>) => waiters.push(p),
  } as unknown as ExecutionContext);
  await Promise.all(waiters);
  return message;
}

describe("forwarded copy states where a reply really goes", () => {
  const inbox = "support@acme.test";
  const personal = "owner@gmail.com";
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

  it("a Reply-To that differs from the sender is shown, and is where the reply goes", async () => {
    const send = vi
      .spyOn(CloudflareSender.prototype, "send")
      .mockResolvedValue({ id: "provider-id", error: null });
    await receive({
      to: inbox,
      from: "cliente@empresa.test",
      messageId: "forjada",
      dmarc: "fail",
      extra: ["Reply-To: replies@other.test"],
    });
    const copy = send.mock.calls[0][0];
    for (const body of [copy.text!, copy.html!]) {
      expect(body).toContain(
        `sua resposta será enviada por ${inbox} para replies@other.test`,
      );
      expect(body).toContain("Reply-To:");
      expect(body).toContain("o DMARC do remetente não passou");
    }
    send.mockClear();

    // The relayed reply goes exactly where the copy said.
    await receive({
      to: copy.headers!["Reply-To"],
      from: personal,
      messageId: "resposta",
      dmarc: "pass",
    });
    expect(send.mock.calls[0][0].to).toBe("replies@other.test");
  });

  it("without a Reply-To the copy names the sender and raises no warning", async () => {
    const send = vi
      .spyOn(CloudflareSender.prototype, "send")
      .mockResolvedValue({ id: "provider-id", error: null });
    await receive({
      to: inbox,
      from: "cliente@empresa.test",
      messageId: "normal",
      dmarc: "pass",
    });
    const copy = send.mock.calls[0][0];
    expect(copy.text).toContain(
      `sua resposta será enviada por ${inbox} para cliente@empresa.test`,
    );
    expect(copy.text).not.toContain("Reply-To:");
    expect(copy.text).not.toContain("Atenção");
  });
});

describe("password sign-in attempt budget", () => {
  const target: Credentials = {
    name: "Alvo",
    email: "alvo@saasmail.test",
    password: "correct-horse-battery",
  };
  let gate: unknown;
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    gate = (env as any).DISABLE_PASSKEY_GATE;
    (env as any).DISABLE_PASSKEY_GATE = "false";
    await createUserWithPassword(target, "member");
  });
  afterEach(() => {
    (env as any).DISABLE_PASSKEY_GATE = gate;
  });

  const signIn = (password: string, ip: string, email = target.email) =>
    json(
      "/api/auth/sign-in/email",
      { email, password },
      {
        headers: {
          origin: "http://localhost:8080",
          "cf-connecting-ip": ip,
          "x-forwarded-for": ip,
        },
      },
    );

  it("one address gets 10 attempts a minute, then 429 even with the right password", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await signIn(`errada-${i}`, "203.0.113.7", `x${i}@s.test`);
      statuses.push(r.status);
      await r.body?.cancel();
    }
    expect(statuses.every((s) => s === 401)).toBe(true);
    const blocked = await signIn(target.password, "203.0.113.7");
    expect(blocked.status).toBe(429);
    await blocked.body?.cancel();
    // A different address is not collateral damage.
    const other = await signIn(target.password, "198.51.100.9");
    expect(other.status).toBe(200);
  });

  it("one account across many addresses stops after 10", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await signIn(`errada-${i}`, `192.0.2.${i + 1}`);
      statuses.push(r.status);
      await r.body?.cancel();
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("a legitimate login after a couple of typos still works", async () => {
    for (const p of ["typo-1", "typo-2"]) {
      const r = await signIn(p, "203.0.113.20");
      expect(r.status).toBe(401);
      await r.body?.cancel();
    }
    const r = await signIn(target.password, "203.0.113.20");
    expect(r.status).toBe(200);
  });
});
