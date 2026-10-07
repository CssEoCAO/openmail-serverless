import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { appSettings } from "../db/app-settings.schema";
import { emails } from "../db/emails.schema";
import { users, passkeys, sessions } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { hashKey } from "../lib/crypto";
import { reserveBudget, reserveSendBudget } from "../lib/resource-budget";
import {
  signToken,
  signUndoToken,
  verifyUndoToken,
  verifyToken,
} from "../lib/unsubscribe-token";
import {
  createUserWithPassword,
  json,
  registerClient,
  BASE_URL,
} from "./mcp-helpers";
import worker from "../index";

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("security remediation", () => {
  it("normal auth and mailbox queries never copy parameters or URL credentials to logs", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { apiKey } = await createTestUser();
      await createUserWithPassword(
        {
          name: "Private marker",
          email: "private-marker@example.com",
          password: "private-password-marker",
        },
        "member",
      );
      await authFetch("/api/people?token=url-secret-marker", { apiKey });
      const output = JSON.stringify(logs.mock.calls);
      expect(output).not.toMatch(
        /private-marker|private-password-marker|url-secret-marker|Query:|params:/,
      );
      expect(output).not.toContain(apiKey);
    } finally {
      logs.mockRestore();
    }
  });

  it("bootstrap denies missing/wrong/expired authority and permits the operator once", async () => {
    const payload = {
      name: "Owner",
      email: "owner@example.com",
      password: "correct-horse-battery",
    };
    const post = (bootstrapToken?: string) =>
      authFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({ ...payload, bootstrapToken }),
      });
    expect((await post()).status).toBe(403);
    await getDb()
      .insert(appSettings)
      .values({
        key: "__setup_authorization",
        value: await hashKey("operator"),
        updatedAt: Math.floor(Date.now() / 1000) - 1,
      });
    expect((await post("operator")).status).toBe(403);
    await getDb()
      .update(appSettings)
      .set({ updatedAt: Math.floor(Date.now() / 1000) + 900 })
      .where(eq(appSettings.key, "__setup_authorization"));
    expect((await post("intruder")).status).toBe(403);
    expect((await post("operator")).status).toBe(200);
    expect((await post("operator")).status).toBe(403);
    expect(await getDb().select().from(users)).toHaveLength(1);
  });

  it("explicit forbidden inbox and empty permissions never become unrestricted mark-read", async () => {
    const { apiKey, userId } = await createTestUser({ role: "member" });
    await createTestPerson({ id: "person" });
    await createTestEmail({
      id: "private",
      personId: "person",
      recipient: "private@example.com",
    });
    await createTestEmail({
      id: "allowed",
      personId: "person",
      recipient: "allowed@example.com",
    });
    const post = (recipient?: string) =>
      authFetch("/api/people/mark-read", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ personIds: ["person"], recipient }),
      });
    expect((await (await post()).json()).affected).toBe(0);
    await getDb()
      .insert(inboxPermissions)
      .values({ userId, email: "allowed@example.com", createdAt: 1 });
    expect((await (await post("private@example.com")).json()).affected).toBe(0);
    expect((await (await post("allowed@example.com")).json()).affected).toBe(1);
    expect(
      (await getDb().select().from(emails).where(eq(emails.id, "private")))[0]
        .isRead,
    ).toBe(0);
  });

  it("reserves atomically across concurrency, alternate senders and windows", async () => {
    const db = getDb();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        reserveBudget(db, "concurrency", 1, 5, 60, 120),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    await expect(
      reserveBudget(db, "concurrency", 1, 5, 60, 180),
    ).resolves.toBeUndefined();
    await reserveSendBudget(db, "a@example.com", 60);
    await expect(
      reserveSendBudget(db, "a@example.com", 1),
    ).rejects.toMatchObject({ status: 429 });
    // Rejected earlier reservations conservatively spend the global budget.
    await reserveSendBudget(db, "b@example.com", 59);
    await expect(
      reserveSendBudget(db, "c@example.com", 1),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("unbounded DCR stops before durable creation while ordinary registration remains", async () => {
    await registerClient("openid");
    for (let i = 0; i < 4; i++)
      await json("/api/auth/oauth2/register", { client_name: "invalid" });
    const blocked = await json("/api/auth/oauth2/register", {
      client_name: "extra",
      redirect_uris: ["https://example.com/callback"],
      scope: "openid",
    });
    expect(blocked.status).toBe(429);
    const rows = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM oauth_clients`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("the DCR storage cap covers alternate insertion paths atomically", async () => {
    const db = getDb();
    await db.run(sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 500)
      INSERT INTO oauth_clients(id,client_id,redirect_uris) SELECT 'cap-'||x,'cap-'||x,'[]' FROM n`);
    await expect(
      db.run(
        sql`INSERT INTO oauth_clients(id,client_id,redirect_uris) VALUES ('extra','extra','[]')`,
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.all<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM oauth_clients`,
        )
      )[0].n,
    ).toBe(500);
    await db.run(sql`DELETE FROM oauth_clients WHERE id='cap-1'`);
    await expect(
      db.run(
        sql`INSERT INTO oauth_clients(id,client_id,redirect_uris) VALUES ('replacement','replacement','[]')`,
      ),
    ).resolves.toBeDefined();
  });

  it("legacy email links still unsubscribe but cannot authorize undo", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ e: "legacy@example.com", v: 1 }),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.UNSUBSCRIBE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const b64 = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const token = `${b64(bytes)}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)))}`;
    expect(await verifyToken(token, env.UNSUBSCRIBE_SECRET)).toEqual({
      email: "legacy@example.com",
    });
    expect(await verifyUndoToken(token, env.UNSUBSCRIBE_SECRET)).toBeNull();
  });

  it("undo is purpose-bound, single-use and cannot clear a later opt-out", async () => {
    const token = await signToken("a@example.com", env.UNSUBSCRIBE_SECRET);
    const optout = () =>
      authFetch(
        `/api/unsubscribe?token=${encodeURIComponent(token)}&source=user-link`,
        { method: "POST" },
      );
    const undo = (t: string) =>
      authFetch(`/api/unsubscribe/undo?token=${encodeURIComponent(t)}`, {
        method: "POST",
      });
    const issued = await (await optout()).json();
    expect(issued.undoToken).toBeTruthy();
    expect((await undo(token)).status).toBe(401);
    expect((await (await optout()).json()).undoToken).toBeUndefined();
    expect((await undo(issued.undoToken)).status).toBe(200);
    expect((await undo(issued.undoToken)).status).toBe(401);
    await optout();
    expect((await undo(issued.undoToken)).status).toBe(401);
    const short = await signUndoToken(
      "a@example.com",
      "x",
      env.UNSUBSCRIBE_SECRET,
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    try {
      expect(await verifyUndoToken(short, env.UNSUBSCRIBE_SECRET)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("timeline pages mixed history in SQL and rejects oversized/invalid page sizes", async () => {
    const { apiKey } = await createTestUser();
    await createTestPerson({ id: "p" });
    for (let i = 0; i < 23; i++)
      await createTestEmail({
        id: `email-${String(i).padStart(2, "0")}`,
        messageId: `m-${i}@example.com`,
        personId: "p",
        bodyText: "x".repeat(32000),
      });
    const get = (query: string) =>
      authFetch(`/api/emails/by-person/p?${query}`, { apiKey });
    const first = await (await get("page=1")).json();
    const second = await (await get("page=2")).json();
    expect(first.emails).toHaveLength(10);
    expect(second.emails).toHaveLength(10);
    expect(
      first.emails.some((e: { id: string }) =>
        second.emails.some((s: { id: string }) => s.id === e.id),
      ),
    ).toBe(false);
    expect((await get("limit=1000000")).status).toBe(400);
    expect((await get("page=-1")).status).toBe(400);
  });

  it("bad-password responses do not reveal passkeys and verified password cannot release a session", async () => {
    const creds = {
      name: "Owner",
      email: "owner@example.com",
      password: "correct-horse-battery",
    };
    await createUserWithPassword(creds, "admin");
    const [owner] = await getDb().select().from(users);
    await getDb().insert(passkeys).values({
      id: "pk",
      userId: owner.id,
      publicKey: "p",
      credentialID: "c",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    const post = (email: string, password: string) =>
      worker.fetch(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: BASE_URL },
          body: JSON.stringify({ email, password }),
        }),
        { ...env, DISABLE_PASSKEY_GATE: "false" } as any,
        {} as any,
      );
    const known = await post(creds.email, "incorrect-password");
    const unknown = await post("missing@example.com", "incorrect-password");
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    const valid = await post(creds.email, creds.password);
    expect(valid.status).toBe(403);
    expect(valid.headers.get("set-cookie")).toBeNull();
    expect(await getDb().select().from(sessions)).toHaveLength(0);
  });
});
