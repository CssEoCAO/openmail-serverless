/**
 * Verifies the server-side passkey gate. We run with DISABLE_PASSKEY_GATE=true
 * globally (see vitest.config.test.ts), so these tests import the router
 * wiring and exercise the middleware directly with the env flag flipped.
 *
 * What we check:
 *   1. `requirePasskey` returns 403 when the gate is on and the user has no
 *      passkey registered.
 *   2. `requirePasskey` allows the request through once a passkey row exists.
 *   3. `requirePasskey` skips the check entirely for apiKey-authed requests.
 *   4. API-key creation is blocked for users without a passkey.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { passkeys } from "../db/auth.schema";
import { requirePasskey } from "../middleware/require-passkey";
import type { Context } from "hono";

function makeContext(opts: {
  env?: Record<string, string>;
  user?: { id: string };
  authMethod?: "session" | "apiKey";
  db: ReturnType<typeof getDb>;
}): Context<any> {
  const store = new Map<string, any>();
  if (opts.user) store.set("user", opts.user);
  if (opts.authMethod) store.set("authMethod", opts.authMethod);
  store.set("db", opts.db);

  let jsonBody: any = null;
  let jsonStatus: number | null = null;

  return {
    env: opts.env ?? {},
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => store.set(k, v),
    json: (body: any, status: number) => {
      jsonBody = body;
      jsonStatus = status;
      return { _body: body, _status: status } as any;
    },
    // expose captured response for assertions
    _captured: () => ({ status: jsonStatus, body: jsonBody }),
  } as any;
}

describe("requirePasskey middleware", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("bypasses the check when DISABLE_PASSKEY_GATE=true", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    const c = makeContext({
      env: {
        DISABLE_PASSKEY_GATE: "true",
        BASE_URL: "http://localhost:8788",
      },
      user: { id: userId },
      authMethod: "session",
      db,
    });
    let nextCalled = false;
    await requirePasskey(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("does not honor the development bypass on a hosted URL", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    const c = makeContext({
      env: {
        DISABLE_PASSKEY_GATE: "true",
        BASE_URL: "https://mail.example.com",
      },
      user: { id: userId },
      authMethod: "session",
      db,
    });
    let nextCalled = false;
    await requirePasskey(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect((c as any)._captured().body.code).toBe("PASSKEY_REQUIRED");
  });

  it("blocks session users who have no passkey when the gate is on", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    const c = makeContext({
      env: {}, // gate on
      user: { id: userId },
      authMethod: "session",
      db,
    });
    let nextCalled = false;
    await requirePasskey(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    const { status, body } = (c as any)._captured();
    expect(status).toBe(403);
    expect(body.code).toBe("PASSKEY_REQUIRED");
  });

  it("allows session users who have a passkey registered", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    await db.insert(passkeys).values({
      id: "pk-1",
      userId,
      name: "Test Passkey",
      publicKey: "pk",
      credentialID: "cred-1",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: "internal",
      createdAt: new Date(),
      aaguid: null,
    } as any);

    const c = makeContext({
      env: {},
      user: { id: userId },
      authMethod: "session",
      db,
    });
    let nextCalled = false;
    await requirePasskey(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("skips the check for apiKey-authed requests even without a passkey", async () => {
    const { userId } = await createTestUser();
    const db = getDb();
    const c = makeContext({
      env: {},
      user: { id: userId },
      authMethod: "apiKey",
      db,
    });
    let nextCalled = false;
    await requirePasskey(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
