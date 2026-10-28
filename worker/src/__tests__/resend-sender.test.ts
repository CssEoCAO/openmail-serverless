import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendSender } from "../lib/email-sender";

describe("ResendSender", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends Reply-To as reply_to, not as a custom header", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "re_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await new ResendSender("re_test").send({
      from: "Acme <support@acme.test>",
      to: "owner@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {
        "Reply-To": "reply+abc@acme.test",
        "X-Auto-Response-Suppress": "All",
      },
    });
    expect(result.error).toBeNull();
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(body.reply_to).toBe("reply+abc@acme.test");
    expect(body.headers).toEqual({ "X-Auto-Response-Suppress": "All" });
  });
});
