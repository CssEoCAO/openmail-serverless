import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  getDb,
} from "./helpers";
import { registerClient, json } from "./mcp-helpers";
import { sendEmail, replyToEmail } from "../lib/send-email";
import { sendTemplate } from "../lib/send-template";
import { reserveBudget, reserveSendBudget } from "../lib/resource-budget";
import { reserveOutboxBudget, sendViaOutbox } from "../lib/outbox";
import { attachments } from "../db/attachments.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { appSettings } from "../db/app-settings.schema";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const inbox = "me@saasmail.test";
const allowed = { isAdmin: true, inboxes: [] };
const payload = {
  fromAddress: inbox,
  to: "to@example.com",
  subject: "Hello",
  bodyHtml: "<p>Hello</p>",
  transactional: true,
};
const files = [
  {
    filename: "test.txt",
    contentType: "text/plain",
    bytes: new Uint8Array([65]),
    size: 1,
  },
];

async function seedSequence() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await createTestPerson({ id: "person", email: payload.to });
  await createTestEmail({
    id: "received",
    personId: "person",
    recipient: inbox,
  });
  await createTestTemplate({
    slug: "manual",
    fromAddress: inbox,
    subject: "Hello",
    bodyHtml: "<p>Hello</p>",
  });
  await db.insert(sequences).values({
    id: "seq",
    name: "Followup",
    steps: "[]",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sequenceEnrollments).values({
    id: "enrollment",
    sequenceId: "seq",
    personId: "person",
    status: "active",
    variables: "{}",
    fromAddress: inbox,
    enrolledAt: now,
  });
  return db;
}

describe("admission review regressions", () => {
  it("DCR trailing-slash and encoded aliases cannot bypass exhausted admission", async () => {
    const db = getDb();
    await reserveBudget(db, "dcr:all", 100, 100, 86400);
    for (const path of [
      "/api/auth/oauth2/register",
      "/api/auth/oauth2/register/",
      "/api/auth/oauth2/%72egister",
    ]) {
      const response = await json(path, {
        client_name: "Alias fixture",
        redirect_uris: ["https://example.com/callback"],
        scope: "openid",
        token_endpoint_auth_method: "none",
      });
      expect(response.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await db.all<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM oauth_clients`,
        )
      )[0].n,
    ).toBe(0);
  });

  it("DCR collects abandoned anonymous clients but preserves managed clients older than eight days", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    const old = Date.now() - 8 * 86400_000;
    await db.run(
      sql`INSERT INTO oauth_clients(id,client_id,redirect_uris,user_id,created_at) VALUES ('managed','managed','[]',${userId},${old}),('anonymous','anonymous','[]',NULL,${old})`,
    );
    await registerClient("openid");
    const rows = await db.all<{ id: string }>(
      sql`SELECT id FROM oauth_clients WHERE id IN ('managed','anonymous')`,
    );
    expect(rows.map((row) => row.id)).toEqual(["managed"]);
  });

  it.each(["compose", "reply", "template"])(
    "exhausted %s admission leaves R2, attachments and active sequences untouched",
    async (kind) => {
      const db = await seedSequence();
      await reserveSendBudget(db, inbox, 60);
      const put = vi.fn();
      const runtime = {
        ...env,
        DEMO_MODE: "1",
        R2: { put, delete: vi.fn() },
      } as any;
      const action =
        kind === "compose"
          ? sendEmail({ db, env: runtime, payload, files, allowed })
          : kind === "reply"
            ? replyToEmail({
                db,
                env: runtime,
                emailId: "received",
                payload,
                files,
                allowed,
              })
            : sendTemplate({
                db,
                env: runtime,
                slug: "manual",
                to: payload.to,
                fromAddress: inbox,
                variables: {},
                allowed,
              });
      await expect(action).rejects.toMatchObject({ status: 429 });
      expect(put).not.toHaveBeenCalled();
      expect(await db.select().from(attachments)).toHaveLength(0);
      expect((await db.select().from(sequenceEnrollments))[0].status).toBe(
        "active",
      );
    },
  );

  it.each(["compose", "reply"])(
    "legitimate %s reserves once and preserves attachment/cancellation behavior",
    async (kind) => {
      const db = await seedSequence();
      await reserveSendBudget(db, inbox, 59);
      const put = vi.fn(async (...args: Parameters<typeof env.R2.put>) =>
        env.R2.put(...args),
      );
      const runtime = {
        ...env,
        DEMO_MODE: "1",
        R2: { put, delete: (key: string) => env.R2.delete(key) },
      } as any;
      const duplicateCcPayload = {
        ...payload,
        cc: [{ email: "TO@EXAMPLE.COM" }],
      };
      const result =
        kind === "compose"
          ? await sendEmail({
              db,
              env: runtime,
              payload: duplicateCcPayload,
              files,
              allowed,
            })
          : await replyToEmail({
              db,
              env: runtime,
              emailId: "received",
              payload: duplicateCcPayload,
              files,
              allowed,
            });
      expect(result.ok).toBe(true);
      expect(put).toHaveBeenCalledOnce();
      expect(await db.select().from(attachments)).toHaveLength(1);
      expect((await db.select().from(sequenceEnrollments))[0].status).toBe(
        "cancelled",
      );
      const budget = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, `__budget:send:${inbox}:60`));
      expect(Number(budget[0].value)).toBe(60);
    },
  );

  it("outbox capability rejects forged, changed-envelope and reused tickets", async () => {
    const db = getDb();
    const sender = {
      provider: "none" as const,
      maxAttachmentBytes: () => 1000,
      send: vi.fn(async () => ({ id: "fixture", error: null })),
    };
    const params = {
      db,
      env: env as any,
      sender,
      sentEmailId: "send-1",
      fromAddress: inbox,
      from: inbox,
      to: payload.to,
      subject: "Hello",
      html: "<p>Hello</p>",
      transactional: true,
    };
    const budgetReservation = await reserveOutboxBudget(
      db,
      inbox,
      payload.to,
      undefined,
      "send-1",
    );
    await expect(
      sendViaOutbox({ ...params, budgetReservation: {} as any }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sendViaOutbox({ ...params, budgetReservation, sentEmailId: "send-2" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sendViaOutbox({ ...params, budgetReservation, to: "other@example.com" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sender.send).not.toHaveBeenCalled();
    await sendViaOutbox({ ...params, budgetReservation });
    expect(sender.send).toHaveBeenCalledOnce();
    await expect(
      sendViaOutbox({ ...params, budgetReservation }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sender.send).toHaveBeenCalledOnce();
  });
});
