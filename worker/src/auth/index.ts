import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { MCP_SCOPES } from "./scopes";
import { mcpAudience } from "../mcp/resource";

/**
 * Scopes advertised to OAuth clients: the OpenID set plus saasmail's own
 * capability scopes. MCP tools are gated on the latter (see auth/scopes.ts).
 */
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  ...MCP_SCOPES,
];

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema }) : ({} as any);
  const baseURL = env?.BASE_URL || "http://localhost:8080";

  // Fail closed rather than silently signing with better-auth's published
  // default. The library only *warns* when the secret is missing, and its
  // NODE_ENV check does not fire on Workers — so an operator who upgrades
  // without setting the secret would come up issuing OAuth tokens anyone can
  // forge. `env` is undefined only under the schema-generation CLI, which
  // never signs anything.
  if (env && !env.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Run `wrangler secret put BETTER_AUTH_SECRET` " +
        "(or add it to .dev.vars) — it signs sessions and protects the OAuth signing keys.",
    );
  }

  return betterAuth({
    baseURL,
    // Passed explicitly: better-auth resolves this from `process.env`, which
    // is not where `wrangler secret put` values reliably land. Without it the
    // library can silently fall back to its well-known default secret, which
    // would also protect the OAuth signing keys in `jwkss`.
    secret: env?.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    plugins: [
      admin(),
      openAPI(),
      passkey(),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        // MCP clients (Claude, Copilot) self-register on first connect; there
        // is no way to pre-provision them, so RFC 7591 registration is open.
        // Registration only creates a client — it grants no access until a
        // user completes the login + consent flow.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: OAUTH_SCOPES,
        // 1.7 replaced `validAudiences` with persisted resources (seeded into
        // `oauth_resources` at boot). A `resource` not listed here is
        // rejected as invalid_target, and an access token is only issued as a
        // *JWT* when a resource was requested — an opaque token can't be
        // verified locally against JWKS. The MCP endpoint is the only resource
        // server, so it is the only resource; the issuer audience 1.6 needed
        // is gone (the userinfo audience is added by the provider itself).
        resources: [mcpAudience(baseURL)],
        // Per-client linkage (default on) would make every client registered
        // before 1.7 fail with invalid_target, and with a single resource it
        // gates nothing: any client allowed to authorize may target /mcp.
        // The GHSA-p2fr fix — the resource is bound to the user's grant and
        // can only narrow on token/refresh — does not depend on this.
        enforcePerClientResources: false,
        // 1.7 treats a registration without `application_type` as "web",
        // which forbids loopback redirects — exactly what local MCP clients
        // (Claude Code, the MCP SDK) register: http://localhost:<port>/...
        // "native" accepts those and still accepts https callbacks such as
        // claude.ai's, which is what 1.6 allowed.
        clientRegistrationDefaultApplicationType: "native",
      }),
    ],
    advanced: {
      cookiePrefix: env?.COOKIE_PREFIX || "saasmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: env?.TRUSTED_ORIGINS
      ? env.TRUSTED_ORIGINS.split(",")
      : ["http://localhost:8080"],
  });
}

export const auth = createAuth();
