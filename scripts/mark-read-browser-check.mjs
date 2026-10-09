// UI real, API sintética: não usa sessão, banco nem e-mails de produção.
// Executar na raiz do repo: node scripts/mark-read-browser-check.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

const server = await createServer({
  configFile: false,
  cacheDir: ".wrangler/vite-mark-read",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve("src"),
      "@worker": path.resolve("worker/src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const inbox = "contato@example.test";
const otherInbox = "outra@example.test";
const now = Math.floor(Date.now() / 1000);

function fixture(mode) {
  const message = (id, timestamp, extra = {}) => ({
    id,
    type: "received",
    personId: "p1",
    recipient: inbox,
    fromAddress: "cliente@example.test",
    toAddress: inbox,
    subject: `Assunto ${id}`,
    bodyText: `Texto ${id}`,
    bodyHtml: null,
    isRead: 0,
    cc: [],
    timestamp,
    attachments: [],
    ...extra,
  });
  const emails = [
    message("latest", now, { bodyHtml: "<p>Mensagem HTML aberta</p>" }),
    message("older", now - 60),
    message("already-read", now - 120, { isRead: 1 }),
    message("sent", now - 180, {
      type: "sent",
      fromAddress: inbox,
      toAddress: "cliente@example.test",
      isRead: null,
    }),
    message("other-inbox", now - 240, { recipient: otherInbox }),
  ];
  const unread = (address) =>
    emails.filter(
      (e) =>
        e.type === "received" &&
        e.isRead === 0 &&
        (!address || e.recipient === address),
    ).length;
  const row = () => ({
    type: mode === "group" ? "group" : "person",
    id: mode === "group" ? "g1" : "p1",
    email: "cliente@example.test",
    name: "Cliente Teste",
    inbox,
    participants: [
      { id: "p1", email: "cliente@example.test", name: "Cliente Teste" },
    ],
    ccParticipants: [],
    lastEmailAt: now,
    latestSubject: "Assunto latest",
    unreadCount: unread(mode === "group" ? inbox : undefined),
    totalCount: emails.length,
    recipientCount: 2,
    recipients: [inbox, otherInbox],
    hasAttachment: 0,
  });
  return { emails, unread, row, attempts: [], fail: false, reads: 0 };
}

async function scenario(mode, mobile = false, fail = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const state = fixture(mode);
  state.fail = fail;
  const unexpected = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.routeWebSocket("**/*", (ws) => ws.close());
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    const pathname = url.pathname;
    if (
      request.method() === "PATCH" &&
      /^\/api\/emails\/[^/]+$/.test(pathname)
    ) {
      const id = pathname.split("/").at(-1);
      assert.deepEqual(request.postDataJSON(), { isRead: true });
      state.attempts.push(id);
      await delay(50);
      if (state.fail) return send({ error: "Falha simulada" }, 500);
      const email = state.emails.find((e) => e.id === id);
      assert.equal(email.type, "received");
      email.isRead = 1;
      return send({ success: true });
    }
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${pathname}`);
      return send({ error: "Mutacao inesperada" }, 500);
    }
    if (pathname === "/api/config")
      return send({ passkeyRequired: false, brandName: "E-mail" });
    if (pathname === "/api/auth/get-session")
      return send({
        session: {
          id: "test-session",
          userId: "test-user",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        user: {
          id: "test-user",
          email: "dono@example.test",
          name: "Teste",
          role: "admin",
        },
      });
    if (pathname === "/api/user/passkeys") return send({ hasPasskey: true });
    if (pathname === "/api/outbox/count") return send({ count: 0 });
    if (pathname === "/api/drafts") return send({ drafts: [] });
    if (pathname === "/api/sequences/people/p1/enrollment")
      return send({ enrollment: null });
    if (pathname === "/api/stats")
      return send({
        totalPeople: 1,
        totalEmails: state.emails.length,
        unreadCount: state.unread(),
        recipients: [inbox],
        senderIdentities: [
          { email: inbox, displayName: "Contato", signatureHtml: null },
        ],
        inboxes: [inbox, otherInbox].map((email) => ({
          email,
          displayName: null,
          podeEnviar: true,
          total: 4,
          naoLidas: state.unread(email),
          ultima: now,
        })),
      });
    if (pathname === "/api/people/grouped")
      return send({
        data: [state.row()],
        total: 1,
        page: 1,
        limit: 40,
        aggregates: {
          unreadRowCount: state.row().unreadCount > 0 ? 1 : 0,
          attachmentRowCount: 0,
          multiInboxRowCount: 1,
          totalUnreadEmails: state.row().unreadCount,
        },
      });
    if (pathname === "/api/people/p1") return send(state.row());
    if (pathname === "/api/emails/by-person/p1") {
      state.reads++;
      return send({
        emails: state.emails,
        inboxes: [inbox, otherInbox].map((email) => ({
          email,
          displayName: null,
          displayMode: mode,
        })),
      });
    }
    if (pathname === "/api/conversations/g1/emails")
      return send({
        conversation: state.row(),
        emails: state.emails.filter((e) => e.recipient === inbox).toReversed(),
      });
    unexpected.push(pathname);
    return send({ error: "Rota inesperada" }, 404);
  });
  try {
    await page.goto(base);
    const row = page.getByTestId(mode === "group" ? "group-row" : "person-row");
    await expect(row).toBeVisible();
    if (!mobile && mode !== "group") {
      await row.hover();
      await expect.poll(() => state.reads).toBeGreaterThan(0);
    }
    assert.deepEqual(state.attempts, [], "Listagem/prefetch nao marca leitura");
    await row.click();
    const messages = page.getByTestId(
      mode === "thread" ? "thread-message" : "chat-bubble",
    );
    await expect(messages.filter({ hasText: "Texto older" })).toBeVisible();
    await expect
      .poll(() => state.attempts.toSorted())
      .toEqual(["latest", "older"]);
    if (fail) {
      await expect.poll(() => state.reads).toBeGreaterThan(1);
      await expect(
        page.locator('[data-email-id="latest"] [aria-label="Não lida"]'),
      ).toBeVisible();
      await delay(400);
      assert.deepEqual(
        state.attempts.toSorted(),
        ["latest", "older"],
        "Falha nao inicia loop de PATCH",
      );
      assert.equal(state.unread(), 3);
      state.fail = false;
      await page.reload();
      await expect.poll(() => state.unread()).toBe(1);
      assert.deepEqual(state.attempts.toSorted(), [
        "latest",
        "latest",
        "older",
        "older",
      ]);
    } else {
      await expect.poll(() => state.unread()).toBe(1);
      await expect(messages.filter({ hasText: "Texto older" })).toBeVisible();
      if (!mobile) {
        const remaining = mode === "group" ? 0 : 1;
        await expect(
          row.locator('[role="button"][title="Marcar como lida"]'),
        ).toHaveCount(remaining);
        await expect(
          page.getByText(
            `${remaining} não ${remaining === 1 ? "lida" : "lidas"} · 1 conversa`,
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Todas as caixas" }),
        ).toContainText("1");
      }
      await delay(150);
      assert.deepEqual(
        state.attempts.toSorted(),
        ["latest", "older"],
        "Uma gravacao por mensagem, mesmo apos atualizar os contadores",
      );
    }
    assert.equal(state.emails.find((e) => e.id === "other-inbox").isRead, 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${mode} ${mobile ? "mobile" : "desktop"}${fail ? " falha + reabertura" : " abertura + contadores"}`,
    );
  } finally {
    await context.close();
  }
}

try {
  for (const mode of ["thread", "chat", "group"]) {
    await scenario(mode);
    await scenario(mode, true);
  }
  await scenario("thread", false, true);
} finally {
  await browser.close();
  await server.close();
}
