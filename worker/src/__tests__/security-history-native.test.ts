import { expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../index";
import { isDevEnvironment } from "../lib/is-dev";

it("DEMO_MODE não desliga passkey em host publicado", () => {
  expect(
    isDevEnvironment({
      ...env,
      BASE_URL: "https://email.example",
      DEMO_MODE: "1",
    } as any),
  ).toBe(false);
  expect(
    isDevEnvironment({
      ...env,
      BASE_URL: "http://localhost:8788",
      DEMO_MODE: "1",
    } as any),
  ).toBe(true);
});
it("documento SPA recebe CSP e proteções de navegador", async () => {
  const r = await worker.fetch(
    new Request("https://email.example/inbox"),
    {
      ...env,
      ASSETS: {
        fetch: async () =>
          new Response("<html><body>SPA</body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    } as any,
    createExecutionContext(),
  );
  expect(r.headers.get("Content-Security-Policy")).toContain(
    "script-src 'self'",
  );
  expect(r.headers.get("Content-Security-Policy")).toContain(
    "object-src 'none'",
  );
  expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(await r.text()).toContain("SPA");
});
