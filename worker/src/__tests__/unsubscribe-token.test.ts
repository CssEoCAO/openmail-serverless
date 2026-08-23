import { describe, it, expect } from "vitest";
import {
  MAX_UNSUBSCRIBE_TOKEN_LENGTH,
  signToken,
  verifyToken,
} from "../lib/unsubscribe-token";

const SECRET = "test-secret-do-not-use-in-prod";

describe("unsubscribe-token", () => {
  it("round-trips: signed token verifies back to the input email", async () => {
    const t = await signToken("alice@example.com", SECRET);
    expect(await verifyToken(t, SECRET)).toEqual({
      email: "alice@example.com",
    });
  });

  it("lowercases the email in the payload", async () => {
    const t = await signToken("Alice@Example.COM", SECRET);
    expect(await verifyToken(t, SECRET)).toEqual({
      email: "alice@example.com",
    });
  });

  it("rejects a tampered signature", async () => {
    const t = await signToken("alice@example.com", SECRET);
    const [payload, sig] = t.split(".");
    const tampered = `${payload}.${sig.slice(0, -1)}A`;
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = await signToken("alice@example.com", SECRET);
    const [, sig] = t.split(".");
    // Re-encode with a different email but keep the original signature
    const newPayload = btoa(JSON.stringify({ e: "bob@example.com", v: 1 }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const tampered = `${newPayload}.${sig}`;
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const t = await signToken("alice@example.com", SECRET);
    expect(await verifyToken(t, "other-secret")).toBeNull();
  });

  it("returns null (does not throw) for malformed input", async () => {
    expect(await verifyToken("", SECRET)).toBeNull();
    expect(await verifyToken("no-dot", SECRET)).toBeNull();
    expect(await verifyToken("a.b.c", SECRET)).toBeNull();
    expect(await verifyToken("not-base64.not-base64", SECRET)).toBeNull();
  });

  it("fails closed when the signing secret is missing", async () => {
    await expect(signToken("alice@example.com", undefined)).rejects.toThrow(
      /UNSUBSCRIBE_SECRET/,
    );
    await expect(signToken("alice@example.com", "")).rejects.toThrow(
      /UNSUBSCRIBE_SECRET/,
    );
    expect(await verifyToken("payload.signature", undefined)).toBeNull();
    expect(await verifyToken("payload.signature", "")).toBeNull();
  });

  it("rejects oversized tokens before decoding or hashing", async () => {
    expect(
      await verifyToken("a".repeat(MAX_UNSUBSCRIBE_TOKEN_LENGTH + 1), SECRET),
    ).toBeNull();
  });
});
