const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const DEFAULT_API_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
// Multipart parsing plus provider base64/JSON encoding briefly keeps several
// copies of each attachment in a 128 MiB Worker isolate. Ten MiB leaves safe
// headroom for those copies and application state.
export const SEND_API_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const MCP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function configuredOrigins(env: CloudflareBindings): Set<string> {
  const candidates = [env.BASE_URL, ...(env.TRUSTED_ORIGINS?.split(",") ?? [])];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origins.add(url.origin);
    } catch {
      // Invalid configured origins grant no access.
    }
  }
  return origins;
}

/**
 * Session cookies are SameSite=Lax, but "same-site" includes sibling
 * subdomains. Require an exact configured Origin on unsafe browser requests so
 * a compromised sibling site cannot mutate this mailbox with the user's
 * ambient session. API-key requests do not use this check.
 */
export function isTrustedSessionMutation(
  request: Request,
  env: CloudflareBindings,
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

  const origin = request.headers.get("Origin");
  if (!origin || origin === "null") return false;

  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    return configuredOrigins(env).has(parsed.origin);
  } catch {
    return false;
  }
}

export function isSendApiPath(path: string): boolean {
  return path === "/api/send" || path.startsWith("/api/send/");
}
