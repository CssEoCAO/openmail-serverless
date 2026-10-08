import { expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../index";

// O Worker serve os arquivos do app (run_worker_first). Estes testes trocam o
// binding ASSETS por uma resposta fixa e conferem o que o Worker faz com ela.
function comAssets(resposta: () => Response) {
  return { ...env, ASSETS: { fetch: async () => resposta() } } as any;
}

it("arquivo com hash em /assets/ vai com cache de um ano", async () => {
  const r = await worker.fetch(
    new Request("https://email.example/assets/index-abc123.js"),
    comAssets(
      () =>
        new Response("export {}", {
          headers: {
            "Content-Type": "text/javascript",
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        }),
    ),
    createExecutionContext(),
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe(
    "public, max-age=31536000, immutable",
  );
});

it("fonte em /fonts/ também vai com cache de um ano", async () => {
  const r = await worker.fetch(
    new Request("https://email.example/fonts/inter-latin.woff2"),
    comAssets(
      () =>
        new Response("woff2", { headers: { "Content-Type": "font/woff2" } }),
    ),
    createExecutionContext(),
  );
  expect(r.headers.get("Cache-Control")).toBe(
    "public, max-age=31536000, immutable",
  );
});

it("pedaço que um deploy apagou devolve 404, não o index.html", async () => {
  const r = await worker.fetch(
    new Request("https://email.example/assets/index-velho.js"),
    comAssets(
      () =>
        new Response("<html><body>SPA</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    ),
    createExecutionContext(),
  );
  expect(r.status).toBe(404);
  expect(r.headers.get("Cache-Control") ?? "").not.toContain("immutable");
});

it("documento da SPA não ganha cache longo e a CSP não libera fonte de fora", async () => {
  const r = await worker.fetch(
    new Request("https://email.example/inbox/todas"),
    comAssets(
      () =>
        new Response("<html><body>SPA</body></html>", {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        }),
    ),
    createExecutionContext(),
  );
  expect(r.headers.get("Cache-Control")).toBe(
    "public, max-age=0, must-revalidate",
  );
  const csp = r.headers.get("Content-Security-Policy") ?? "";
  expect(csp).toContain("font-src 'self' data:;");
  expect(csp).not.toContain("googleapis");
  expect(csp).not.toContain("unsafe-inline'; style");
});
