import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { passkeys, users } from "../db/auth.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import {
  type Credentials,
  Jar,
  createUserWithPassword,
  req,
  signIn,
} from "./mcp-helpers";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

describe("BetterAuth admin routes", () => {
  let originalBypass: unknown;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    originalBypass = (env as any).DISABLE_PASSKEY_GATE;
    // Exercise production behavior while retaining the test environment's
    // loopback BASE_URL and trusted origin.
    (env as any).DISABLE_PASSKEY_GATE = "false";
    await createUserWithPassword(ADMIN, "admin");
  });
  afterEach(() => {
    (env as any).DISABLE_PASSKEY_GATE = originalBypass;
  });

  it("requires a registered passkey before privileged plugin endpoints", async () => {
    const jar = new Jar();
    await signIn(jar, ADMIN);

    const blocked = await req("/api/auth/admin/list-users", {
      headers: { cookie: jar.header },
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("PASSKEY_REQUIRED");

    const [user] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN.email));
    await getDb()
      .insert(passkeys)
      .values({
        id: "pk-admin",
        userId: user.id,
        name: "Admin passkey",
        publicKey: "pk",
        credentialID: "credential-admin",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: "internal",
        createdAt: new Date(),
        aaguid: null,
      } as any);

    const allowed = await req("/api/auth/admin/list-users", {
      headers: { cookie: jar.header },
    });
    expect(allowed.status).toBe(200);
  });
});
