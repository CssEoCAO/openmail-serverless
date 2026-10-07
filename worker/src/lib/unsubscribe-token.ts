const encoder = new TextEncoder();
export const MAX_UNSUBSCRIBE_TOKEN_LENGTH = 2048;

function hasSigningSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length > 0;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signToken(
  email: string,
  secret: string | undefined,
): Promise<string> {
  if (!hasSigningSecret(secret)) {
    throw new Error("UNSUBSCRIBE_SECRET is not configured");
  }
  const payload = JSON.stringify({
    e: email.toLowerCase(),
    v: 2,
    p: "unsubscribe",
  });
  const payloadBytes = encoder.encode(payload);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;
}

export async function verifyToken(
  token: string,
  secret: string | undefined,
): Promise<{ email: string } | null> {
  if (
    !token ||
    typeof token !== "string" ||
    token.length > MAX_UNSUBSCRIBE_TOKEN_LENGTH ||
    !hasSigningSecret(secret)
  ) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadEnc, sigEnc] = parts;

  const payloadBytes = b64urlDecode(payloadEnc);
  const sigBytes = b64urlDecode(sigEnc);
  if (!payloadBytes || !sigBytes) return null;

  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  if (!timingSafeEqual(sigBytes, expected)) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (
      typeof decoded?.e !== "string" ||
      !(decoded?.v === 1 || (decoded?.v === 2 && decoded?.p === "unsubscribe"))
    )
      return null;
    return { email: decoded.e };
  } catch {
    return null;
  }
}

export async function signUndoToken(
  email: string,
  suppressionId: string,
  secret: string,
): Promise<string> {
  if (!hasSigningSecret(secret))
    throw new Error("UNSUBSCRIBE_SECRET is not configured");
  const payload = encoder.encode(
    JSON.stringify({
      e: email,
      id: suppressionId,
      v: 2,
      p: "undo",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), payload),
  );
  return `${b64urlEncode(payload)}.${b64urlEncode(sig)}`;
}

export async function verifyUndoToken(
  token: string,
  secret: string | undefined,
): Promise<{ email: string; suppressionId: string } | null> {
  if (
    !hasSigningSecret(secret) ||
    typeof token !== "string" ||
    token.length > MAX_UNSUBSCRIBE_TOKEN_LENGTH
  )
    return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = b64urlDecode(parts[0]);
  const signature = b64urlDecode(parts[1]);
  if (
    !payload ||
    !signature ||
    !(await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signature,
      payload,
    ))
  )
    return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(payload));
    if (
      d.v !== 2 ||
      d.p !== "undo" ||
      typeof d.e !== "string" ||
      typeof d.id !== "string" ||
      !Number.isInteger(d.exp) ||
      d.exp <= Math.floor(Date.now() / 1000)
    )
      return null;
    return { email: d.e, suppressionId: d.id };
  } catch {
    return null;
  }
}
