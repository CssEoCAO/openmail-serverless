import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { exports } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";

describe("health check", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /api/health returns ok", async () => {
    const res = await exports.default.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });
});

describe("auth middleware", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("returns 401 for unauthenticated API requests", async () => {
    const res = await exports.default.fetch("http://localhost/api/people");
    expect(res.status).toBe(401);
  });

  it("allows requests with valid API key", async () => {
    const { apiKey } = await createTestUser();
    const res = await authFetch("/api/people", { apiKey });
    expect(res.status).toBe(200);
  });

  it("rejects requests with invalid API key", async () => {
    const res = await authFetch("/api/people", {
      apiKey: "sk_00000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });

  it("revokes API-key access while the owning account is banned", async () => {
    const { apiKey, userId } = await createTestUser();
    await getDb()
      .update(users)
      .set({ banned: true, banExpires: null })
      .where(eq(users.id, userId));

    const res = await authFetch("/api/people", { apiKey });
    expect(res.status).toBe(401);
  });

  it("allows an API key again after a timed ban expires", async () => {
    const { apiKey, userId } = await createTestUser();
    await getDb()
      .update(users)
      .set({ banned: true, banExpires: new Date(Date.now() - 1_000) })
      .where(eq(users.id, userId));

    const res = await authFetch("/api/people", { apiKey });
    expect(res.status).toBe(200);
  });

  it("skips auth for /api/setup paths", async () => {
    const res = await exports.default.fetch(
      "http://localhost/api/setup/status",
    );
    expect(res.status).toBe(200);
  });

  it("skips auth for /api/health", async () => {
    const res = await exports.default.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
  });

  it("skips auth for /api/invites paths", async () => {
    const res = await exports.default.fetch(
      "http://localhost/api/invites/nonexistent-token",
    );
    expect(res.status).toBe(200);
  });
});
