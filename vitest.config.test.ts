import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import path from "path";

export default defineConfig({
  // The frontend's `@/…` alias, so a worker test can import the REAL
  // `src/lib/api.ts` and send its real path strings at the real worker
  // (`__tests__/frontend-api-contract.test.ts`). Without this the client
  // module cannot resolve its own `@/lib/error-message` import.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  plugins: [
    cloudflareTest({
      main: "./worker/src/index.ts",
      wrangler: {
        // Keep unit tests isolated from the production bindings and custom
        // domain in wrangler.jsonc. This is the repository's CI fixture.
        configPath: "./wrangler.jsonc.ci",
      },
      miniflare: {
        d1Databases: ["DB"],
        durableObjects: {
          NOTIFICATIONS_HUB: "NotificationsHub",
        },
        queueProducers: {
          EMAIL_QUEUE: "saasmail-sequence-emails",
        },
        r2Buckets: ["R2"],
        bindings: {
          // `wrangler.jsonc` ships a `<your-deployed-url>` placeholder so new
          // clones don't accidentally send tests to a real deployment. Override
          // with a valid URL so BetterAuth initializes during tests.
          BASE_URL: "http://localhost:8080",
          TRUSTED_ORIGINS: "http://localhost:8080,http://localhost:8788",
          RESEND_API_KEY: "re_test_fake_key",
          // Tests authenticate via API keys (no WebAuthn ceremony available).
          // Disable the passkey gate so the existing fixtures keep working;
          // the enforcement itself is covered by targeted tests in
          // `__tests__/passkey-enforcement.test.ts`.
          DISABLE_PASSKEY_GATE: "true",
          // `.dev.vars` sets DEMO_MODE=1 for `yarn dev`, and miniflare
          // auto-loads those secrets. Force it off for tests so sequence
          // processor / enroll route exercise real (non-demo) behavior.
          DEMO_MODE: "0",
          VAPID_PRIVATE_KEY: "test-vapid-private",
          VAPID_PUBLIC_KEY: "test-vapid-public",
          VAPID_SUBJECT: "mailto:test@example.com",
          UNSUBSCRIBE_SECRET: "test-secret-do-not-use-in-prod",
          // `createAuth` now passes `secret` explicitly rather than relying on
          // better-auth reading process.env, so tests must supply one.
          BETTER_AUTH_SECRET: "test-better-auth-secret-do-not-use-in-prod",
          GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
          GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
          // 32 bytes ("0123456789abcdef" twice), base64-encoded.
          TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        },
      },
    }),
  ],
  test: {
    globals: true,
    // The first authenticated request of a file boots the whole worker in
    // workerd (~7 s locally); on GitHub's runners send-reply-gmail crossed 15 s.
    testTimeout: 30_000,
    hookTimeout: 15_000,
    include: ["worker/src/__tests__/**/*.test.ts"],
  },
});
