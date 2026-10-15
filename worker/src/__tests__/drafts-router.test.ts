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
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { drafts } from "../db/drafts.schema";

const INBOX = "inbox@saasmail.test";
const OTHER_INBOX = "other@saasmail.test";

async function grant(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({ userId, email, createdAt: Math.floor(Date.now() / 1000) });
}

const body = {
  fromAddress: INBOX,
  cc: [{ email: "cc@example.com", name: "Cee" }],
  bodyHtml: "<p>oi</p>",
  bodyText: "oi",
};

describe("drafts router", () => {
  let apiKey: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey, userId } = await createTestUser({ role: "member" }));
    await grant(userId, INBOX);
    await createTestPerson();
    await createTestEmail({ id: "email-1", recipient: INBOX });
  });

  it("saves, reads back, lists and discards a draft", async () => {
    const put = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved).toMatchObject({
      emailId: "email-1",
      personId: "sender-1",
      personEmail: "alice@example.com",
      subject: "Test Subject",
      fromAddress: INBOX,
      cc: body.cc,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
    });
    expect(typeof saved.updatedAt).toBe("number");

    const get = await authFetch("/api/drafts/email-1", { apiKey });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ bodyText: "oi", cc: body.cc });

    const list = await authFetch("/api/drafts", { apiKey });
    expect(list.status).toBe(200);
    const { drafts } = await list.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      emailId: "email-1",
      personId: "sender-1",
      personEmail: "alice@example.com",
      personName: "Alice",
      subject: "Test Subject",
    });

    const del = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect((await authFetch("/api/drafts/email-1", { apiKey })).status).toBe(
      404,
    );
    // Idempotente: apagar de novo continua 204.
    expect(
      (await authFetch("/api/drafts/email-1", { apiKey, method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("second save replaces the first (one draft per user+message)", async () => {
    await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    const put2 = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, cc: [], bodyText: "segunda" }),
    });
    expect(put2.status).toBe(200);
    const rows = await getDb().select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyText).toBe("segunda");
    expect(rows[0].cc).toBeNull();
  });

  it("is scoped per user: another user does not see or overwrite it", async () => {
    await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    const other = await createTestUser({
      id: "user-2",
      email: "two@example.com",
      role: "member",
    });
    await grant(other.userId, INBOX);

    expect(
      (await authFetch("/api/drafts/email-1", { apiKey: other.apiKey })).status,
    ).toBe(404);
    const list = await authFetch("/api/drafts", { apiKey: other.apiKey });
    expect((await list.json()).drafts).toHaveLength(0);

    await authFetch("/api/drafts/email-1", {
      apiKey: other.apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, bodyText: "do outro" }),
    });
    const mine = await authFetch("/api/drafts/email-1", { apiKey });
    expect((await mine.json()).bodyText).toBe("oi");
  });

  it("refuses a message outside the caller's inboxes with 404, and a foreign From with 403", async () => {
    await createTestEmail({
      id: "email-2",
      recipient: OTHER_INBOX,
      messageId: "msg-2@example.com",
    });
    const put = await authFetch("/api/drafts/email-2", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, fromAddress: OTHER_INBOX }),
    });
    expect(put.status).toBe(404);

    const badFrom = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, fromAddress: OTHER_INBOX }),
    });
    expect(badFrom.status).toBe(403);

    expect((await authFetch("/api/drafts/nope", { apiKey })).status).toBe(404);
    expect(await getDb().select().from(drafts)).toHaveLength(0);
  });

  it("hides a draft from the list once the inbox is no longer allowed", async () => {
    await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    await getDb().delete(inboxPermissions);
    const list = await authFetch("/api/drafts", { apiKey });
    expect((await list.json()).drafts).toHaveLength(0);
    // ...mas o dono ainda descarta o que escreveu.
    expect(
      (await authFetch("/api/drafts/email-1", { apiKey, method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("accepts a sent message as the reply target", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(sentEmails).values({
      id: "sent-1",
      personId: "sender-1",
      fromAddress: INBOX,
      toAddress: "alice@example.com",
      subject: "Re: hi",
      status: "sent",
      sentAt: now,
      createdAt: now,
    });
    const put = await authFetch("/api/drafts/sent-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).personId).toBe("sender-1");
  });

  it("rejects an oversized body and an invalid From", async () => {
    const big = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, bodyHtml: "x".repeat(200_001) }),
    });
    expect(big.status).toBe(400);
    const bad = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, fromAddress: "not-an-email" }),
    });
    expect(bad.status).toBe(400);
  });

  it("If-None-Match: * only creates — 412 when a draft exists, nothing overwritten", async () => {
    const first = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      headers: { "If-None-Match": "*" },
      body: JSON.stringify({ ...body, bodyText: "do CLI" }),
    });
    expect(first.status).toBe(200);

    const again = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      headers: { "If-None-Match": "*" },
      body: JSON.stringify({ ...body, bodyText: "segunda tentativa" }),
    });
    expect(again.status).toBe(412);

    const rows = await getDb().select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyText).toBe("do CLI");

    // Sem o header, o PUT da UI continua substituindo.
    const ui = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ ...body, bodyText: "da UI" }),
    });
    expect(ui.status).toBe(200);
    expect((await getDb().select().from(drafts))[0].bodyText).toBe("da UI");
  });

  it("saves for an allowed inbox that has no sender identity (receive-only)", async () => {
    // Nenhuma linha em sender_identities para INBOX neste teste — e o PUT
    // passa, porque salvar exige permissão na caixa, não identidade de envio.
    const put = await authFetch("/api/drafts/email-1", {
      apiKey,
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).fromAddress).toBe(INBOX);
  });

  it("requires authentication", async () => {
    const res = await authFetch("/api/drafts");
    expect(res.status).toBe(401);
  });
});
