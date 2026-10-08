import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { injectDb } from "./db/middleware";
import { createAuth } from "./auth";
import { apiKeys } from "./db/api-keys.schema";
import { users, sessions } from "./db/auth.schema";
import { eq, sql } from "drizzle-orm";
import { hashKey } from "./lib/crypto";
import { reserveBudget } from "./lib/resource-budget";
import { handleEmail } from "./email-handler";
import { peopleRouter } from "./routers/people-router";
import { emailsRouter } from "./routers/emails-router";
import { conversationsRouter } from "./routers/conversations-router";
import {
  sendRouter,
  CcEntrySchema,
  ReplyEmailSchema,
  SendEmailSchema,
} from "./routers/send-router";
import { attachmentsRouter } from "./routers/attachments-router";
import { statsRouter } from "./routers/stats-router";
import { setupRouter } from "./routers/setup-router";
import { emailTemplatesRouter } from "./routers/email-templates-router";
import { adminRouter } from "./routers/admin-router";
import { adminInboxesRouter } from "./routers/admin-inboxes-router";
import { oauthAppsRouter } from "./routers/oauth-apps-router";
import { invitesRouter } from "./routers/invites-router";
import { userRouter } from "./routers/user-router";
import { apiKeysRouter } from "./routers/api-keys-router";
import { sequencesRouter } from "./routers/sequences-router";
import { handleScheduled, handleQueueBatch } from "./lib/sequence-processor";
import type { SequenceEmailMessage } from "./lib/sequence-processor";
import { processOutbox } from "./lib/outbox";
import { notificationsRouter } from "./routers/notifications-router";
import { blocklistRouter } from "./routers/blocklist-router";
import { suppressionsRouter } from "./routers/suppressions-router";
import { webhooksRouter } from "./routers/webhooks-router";
import { unsubscribeRouter } from "./routers/unsubscribe-router";
import { outboxRouter } from "./routers/outbox-router";
import { draftsRouter } from "./routers/drafts-router";
import { bootstrapRouter } from "./routers/bootstrap-router";
export { NotificationsHub } from "./do/notifications";
import type { Variables } from "./variables";
import type { MiddlewareHandler } from "hono";
import { injectAllowedInboxes } from "./middleware/inject-allowed-inboxes";
import { requirePasskey } from "./middleware/require-passkey";
import { passkeys } from "./db/auth.schema";
import { isDevEnvironment } from "./lib/is-dev";
import { registerMcpRoutes } from "./mcp/http";
import {
  BEARER_AUTH_SCHEME,
  bearerAuthSecurityScheme,
  openapiInfoDescription,
} from "./lib/openapi-auth";
import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  isSendApiPath,
  isTrustedSessionMutation,
  MCP_BODY_LIMIT_BYTES,
  SEND_API_BODY_LIMIT_BYTES,
} from "./lib/request-security";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

app.openAPIRegistry.register("CcEntry", CcEntrySchema);
app.openAPIRegistry.register("SendEmailSchema", SendEmailSchema);
app.openAPIRegistry.register("ReplyEmailSchema", ReplyEmailSchema);

app.openAPIRegistry.registerComponent(
  "securitySchemes",
  BEARER_AUTH_SCHEME,
  bearerAuthSecurityScheme,
);

// Reject oversized bodies before DB/auth initialization. The send endpoints
// need room for attachments; every other JSON/API surface stays deliberately
// small. Hono's middleware also counts chunked bodies rather than trusting
// Content-Length.
const defaultApiBodyLimit = bodyLimit({
  maxSize: DEFAULT_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});
const sendApiBodyLimit = bodyLimit({
  maxSize: SEND_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});
const mcpBodyLimit = bodyLimit({
  maxSize: MCP_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});

app.use("/api/*", (c, next) =>
  isSendApiPath(c.req.path)
    ? sendApiBodyLimit(c, next)
    : defaultApiBodyLimit(c, next),
);
app.use("/mcp", mcpBodyLimit);

// Middleware
app.use("*", injectDb);
app.use("*", async (c, next) => {
  await next();
  // URLs may contain OAuth/unsubscribe credentials. Log only bounded metadata.
  console.log("[request]", c.req.method, c.res.status);
});
// `exposeHeaders` is required so browser-based MCP clients (e.g. Claude.ai
// connectors) can read the `WWW-Authenticate` challenge on a 401 to discover
// the OAuth protected-resource metadata URL, plus the `Mcp-Session-Id` header
// used by the streamable-HTTP transport. Without these a cross-origin MCP
// client sees an opaque 401 and reports "Couldn't reach the MCP server".
app.use(
  "*",
  cors({
    origin: "*",
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  }),
);

// Paths that don't participate in our session/passkey/inbox pipeline.
// (BetterAuth handles its own auth at /api/auth/*; setup/invites/health/config
// are intentionally public.)
function isUnauthenticatedPath(path: string): boolean {
  return (
    path.startsWith("/api/auth") ||
    path.startsWith("/api/setup") ||
    path.startsWith("/api/invites") ||
    path.startsWith("/api/unsubscribe") ||
    path === "/api/health" ||
    path === "/api/config"
  );
}

// Paths that require a session but are exempt from the passkey requirement.
// Users must be able to check their own passkey status before they've
// registered one (so the frontend can route them to /setup-passkey).
function isPasskeyExemptPath(path: string): boolean {
  return path === "/api/user/passkeys";
}

// Apply the passkey policy only AFTER Better Auth proves the password. Failed
// logins retain exactly Better Auth's response and password-hash work, so an
// anonymous caller cannot enumerate accounts or their authentication method.
app.post("/api/auth/sign-in/email", async (c, next) => {
  if (isDevEnvironment(c.env)) return next();
  const response = await createAuth(c.env).handler(c.req.raw);
  if (!response.ok) return response;
  const login = (await response.clone().json()) as {
    user?: { id?: string };
    token?: string;
  };
  if (!login.user?.id || !login.token) return response;
  const db = c.get("db");
  const pkRows = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, login.user.id))
    .limit(1);
  if (pkRows.length > 0) {
    // Do not release the created session or its Set-Cookie headers.
    await db.delete(sessions).where(eq(sessions.token, login.token));
    return c.json(
      {
        error:
          "Password sign-in is disabled for accounts with a registered passkey. Please sign in with your passkey.",
        code: "PASSKEY_REQUIRED_FOR_SIGNIN",
      },
      403,
    );
  }
  return response;
});

// BetterAuth's admin plugin exposes user creation, role changes, password
// resets, impersonation and deletion under /api/auth/admin/*. Those routes
// handle their own session/role checks, but otherwise sit outside saasmail's
// passkey middleware because /api/auth/* is public to BetterAuth. Resolve the
// same session here and enforce the second-factor boundary before handing a
// privileged request to the plugin.
app.use("/api/auth/admin/*", async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return next();

  c.set("user", session.user);
  c.set("authMethod", "session");
  return requirePasskey(c, next);
});

// BetterAuth handler
app.post(
  "/api/auth/oauth2/register",
  bodyLimit({ maxSize: 16 * 1024 }),
  async (c, next) => {
    const db = c.get("db");
    // Fixed shards bound storage while retaining a per-origin budget. Only the
    // edge-provided address is used; forwarded headers are attacker supplied.
    const hash = await hashKey(c.req.header("cf-connecting-ip") ?? "unknown");
    await reserveBudget(db, "dcr:all", 1, 100, 86400);
    await reserveBudget(
      db,
      `dcr:origin:${parseInt(hash.slice(0, 4), 16) % 128}`,
      1,
      5,
      60,
    );
    // Only abandoned anonymous registrations are disposable. Managed clients
    // retain their owner even before any consent or token has been issued.
    await db.run(sql`DELETE FROM oauth_clients WHERE id IN (
    SELECT id FROM oauth_clients WHERE created_at < ${Date.now() - 7 * 86400_000} AND user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM oauth_consents WHERE client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens WHERE client_id = oauth_clients.client_id)
      LIMIT 100
  )`);
    return next();
  },
);

app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();

  // Try session cookie first
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (session) {
    c.set("user", session.user);
    c.set("authMethod", "session");
    return next();
  }

  // Try Bearer token (API key)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer sk_")) {
    const token = authHeader.slice(7); // Remove "Bearer "
    const tokenHash = await hashKey(token);

    const db = c.get("db");
    const rows = await db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, tokenHash))
      .limit(1);

    if (rows.length > 0) {
      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, rows[0].userId))
        .limit(1);

      if (userRows.length > 0) {
        const user = userRows[0];
        if (user.banned && (!user.banExpires || user.banExpires > new Date())) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        c.set("user", user);
        c.set("authMethod", "apiKey");
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

// Custom API mutations authenticated by a browser session need their own
// CSRF boundary. BetterAuth protects /api/auth/*; API keys are explicit bearer
// credentials and are intentionally usable without a browser Origin header.
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
  if (
    c.get("authMethod") === "session" &&
    !isTrustedSessionMutation(c.req.raw, c.env)
  ) {
    return c.json({ error: "Forbidden origin" }, 403);
  }
  return next();
});

// Enforce passkey registration for session-cookie users. Runs before
// inbox-scoping so an unregistered user gets a consistent 403.
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
  if (isPasskeyExemptPath(c.req.path)) return next();
  return requirePasskey(c, next);
});

// Inject allowed inboxes for all authenticated API routes
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
  return injectAllowedInboxes(c, next);
});

// Admin guard middleware
const requireAdmin: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
};

// API Routes
app.route("/api/people", peopleRouter);
app.route("/api/emails", emailsRouter);
app.route("/api/conversations", conversationsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/setup", setupRouter);
app.route("/api/email-templates", emailTemplatesRouter);
app.route("/api/user", userRouter);
app.route("/api/api-keys", apiKeysRouter);
app.route("/api/invites", invitesRouter);

// Sequence definitions are global instance config; enrollments remain scoped
// by their from-address inside the router.
const requireSequenceAdmin: typeof requireAdmin = (c, next) =>
  c.req.method === "GET" ? next() : requireAdmin(c, next);
app.use("/api/sequences", requireSequenceAdmin);
app.use("/api/sequences/:id", requireSequenceAdmin);
app.route("/api/sequences", sequencesRouter);
app.route("/api/notifications", notificationsRouter);

// Block rules and their destructive purge apply to every inbox.
app.use("/api/blocklist", requireAdmin);
app.use("/api/blocklist/*", requireAdmin);
app.route("/api/blocklist", blocklistRouter);
app.route("/api/outbox", outboxRouter);
app.route("/api/drafts", draftsRouter);

// Admin routes (require admin role)
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);
app.route("/api/admin/inboxes", adminInboxesRouter);

// Registered OAuth clients. Admin-only: registration is open to any caller so
// MCP clients can self-register, which makes an operator-visible list and a
// revocation path the control that actually bounds it.
app.use("/api/oauth-apps", requireAdmin);
app.use("/api/oauth-apps/*", requireAdmin);
app.route("/api/oauth-apps", oauthAppsRouter);

// Suppressions CRUD — admin-only (not under /api/admin/ for UX but enforced
// here with the same role guard).
app.use("/api/suppressions/*", requireAdmin);
app.use("/api/suppressions", requireAdmin);
app.route("/api/suppressions", suppressionsRouter);

// Webhook config — admin-only global instance config.
app.use("/api/webhook", requireAdmin);
app.use("/api/webhook/*", requireAdmin);
app.route("/api/webhook", webhooksRouter);

// Public unsubscribe endpoints — token-authenticated, no session/API key.
// Allowlisted in `isUnauthenticatedPath` above.
app.route("/api/unsubscribe", unsubscribeRouter);

// Also mount at `/unsubscribe` so the same URL we put in the `List-Unsubscribe`
// email header (which doubles as the body link → SPA at GET /unsubscribe) handles
// RFC 8058 one-click POSTs from mail clients like Fastmail / Gmail / Apple Mail.
// GET requests don't match the router and fall through to the SPA assets handler.
app.route("/unsubscribe", unsubscribeRouter);

// Public bootstrap routes (no auth) — documented in OpenAPI under Bootstrap tag
app.route("/api", bootstrapRouter);

// MCP endpoint + OAuth discovery. Registered before the SPA catch-all so
// `/.well-known/*` isn't served index.html. `/mcp` authenticates with OAuth
// bearer tokens via mcpHandler rather than the session/API-key pipeline, and
// it sits outside `/api/*` so that middleware never applies to it.
registerMcpRoutes(app);

// Swagger UI
app.get("/swagger-ui", swaggerUI({ url: "/doc" }));
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "saasmail API",
    version: "1.0.0",
    description: openapiInfoDescription,
  },
});

// SPA fallback
app.all("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const path = new URL(c.req.url).pathname;
  // Vite põe hash no nome de tudo em /assets/, e as fontes trocam de nome quando
  // mudam: o navegador guarda por um ano e reabrir o app não pergunta nada ao
  // servidor (o padrão do Workers é max-age=0, uma revalidação por arquivo).
  if (path.startsWith("/assets/") || path.startsWith("/fonts/")) {
    // Pedaço apagado por um deploy (aba aberta desde antes) cairia no fallback
    // da SPA e voltaria o index.html com 200; o 404 faz o app recarregar.
    if (
      response.headers.get("Content-Type")?.includes("text/html") ||
      (!response.ok && response.status !== 304)
    ) {
      return c.text("Not found", 404);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!response.headers.get("Content-Type")?.includes("text/html"))
    return response;
  const headers = new Headers(response.headers);
  // O `vite dev` injeta um preâmbulo inline do React: só o dev em loopback roda.
  const devLocal =
    isDevEnvironment(c.env) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname);
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'${devLocal ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

export default {
  fetch: app.fetch,
  email: handleEmail,
  async scheduled(
    event: ScheduledEvent,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      handleScheduled(env)
        .catch((err) => console.error("[cron] sequence dispatch failed:", err))
        .then(() => processOutbox(env)),
    );
  },
  async queue(
    batch: MessageBatch<SequenceEmailMessage>,
    env: CloudflareBindings,
  ) {
    await handleQueueBatch(batch, env);
  },
};
