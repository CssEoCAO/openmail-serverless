import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations, cleanDb } from "./helpers";
import {
  BASE_URL,
  type Credentials,
  Jar,
  createUserWithPassword,
  req,
  signIn,
} from "./mcp-helpers";
import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  SEND_API_BODY_LIMIT_BYTES,
  isSendApiPath,
  isTrustedSessionMutation,
} from "../lib/request-security";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

describe("request security helpers", () => {
  const bindings = {
    BASE_URL: "https://mail.example.com",
    TRUSTED_ORIGINS: "https://mail.example.com,https://mail.example.com",
  } as any;

  it("requires an exact configured Origin for unsafe session requests", () => {
    expect(
      isTrustedSessionMutation(
        new Request("https://mail.example.com/api/people", {
          method: "POST",
          headers: { Origin: "https://mail.example.com" },
        }),
        bindings,
      ),
    ).toBe(true);
    expect(
      isTrustedSessionMutation(
        new Request("https://mail.example.com/api/people", {
          method: "POST",
          headers: { Origin: "https://evil.example.com" },
        }),
        bindings,
      ),
    ).toBe(false);
    expect(
      isTrustedSessionMutation(
        new Request("https://mail.example.com/api/people", {
          method: "POST",
        }),
        bindings,
      ),
    ).toBe(false);
  });

  it("allows safe methods and identifies attachment-capable send paths", () => {
    expect(
      isTrustedSessionMutation(
        new Request("https://mail.example.com/api/people"),
        bindings,
      ),
    ).toBe(true);
    expect(isSendApiPath("/api/send")).toBe(true);
    expect(isSendApiPath("/api/send/reply/id")).toBe(true);
    expect(isSendApiPath("/api/sender-identities")).toBe(false);
  });
});

describe("session mutation Origin enforcement", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  async function signedInMutation(origin?: string) {
    const jar = new Jar();
    await signIn(jar, ADMIN);
    return req("/api/people/mark-read", {
      method: "POST",
      headers: {
        cookie: jar.header,
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ personIds: ["person-1"] }),
    });
  }

  it("rejects missing and sibling Origins but accepts the configured origin", async () => {
    expect((await signedInMutation()).status).toBe(403);
    expect(
      (await signedInMutation("https://evil.example.com")).status,
    ).toBe(403);
    expect((await signedInMutation(BASE_URL)).status).toBe(200);
  });
});

describe("request body limits", () => {
  it("rejects an oversized API body before parsing or authentication", async () => {
    const res = await exports.default.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(DEFAULT_API_BODY_LIMIT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload too large" });
  });

  it("uses the lower Worker-safe limit for attachment-capable send routes", async () => {
    const res = await exports.default.fetch("http://localhost/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(SEND_API_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });
});
