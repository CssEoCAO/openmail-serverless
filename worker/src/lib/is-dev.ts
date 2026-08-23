/**
 * Returns true when the worker is running in a local/test environment where
 * passkey enforcement should be relaxed so maintainers can exercise the UI
 * without a real WebAuthn ceremony.
 *
 * Gated by both an explicit `DISABLE_PASSKEY_GATE="true"` var and a loopback
 * BASE_URL. Requiring both keeps an accidentally deployed toggle from
 * disabling the passkey boundary on a hosted instance.
 *
 * Demo deploys (see `isDemoMode`) also bypass the passkey gate so preview
 * instances can be explored without registering a WebAuthn credential.
 */
export function isDevEnvironment(env: CloudflareBindings | undefined): boolean {
  if (isDemoMode(env)) return true;
  if (!env) return false;

  const runtime = env as CloudflareBindings & {
    DISABLE_PASSKEY_GATE?: string;
  };
  if (runtime.DISABLE_PASSKEY_GATE !== "true") return false;

  // A forgotten deploy-time toggle must not disable the production passkey
  // boundary. The explicit bypass is accepted only for loopback development;
  // hosted demos use the separate DEMO_MODE switch above.
  try {
    const host = new URL(env.BASE_URL).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Returns true when the worker is running in "demo" mode — a stripped-down
 * deploy that only talks to D1 (and R2 if present), skipping queue
 * enqueues and outbound email sends. Intended for sample/preview deployments
 * where you want to exercise the UI/DB without provisioning queues or an
 * email provider.
 *
 * Toggled by `DEMO_MODE="1"` in the worker's vars (see `wrangler.demo.jsonc`).
 */
export function isDemoMode(env: CloudflareBindings | undefined): boolean {
  const runtime = env as
    | (CloudflareBindings & { DEMO_MODE?: string })
    | undefined;
  return runtime?.DEMO_MODE === "1";
}
