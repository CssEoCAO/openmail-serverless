const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/** Normalize untrusted MIME metadata before it reaches D1 or HTTP headers. */
export function sanitizeContentType(value: string | null | undefined): string {
  const candidate = (value ?? "").trim().slice(0, 255);
  return MIME_TYPE_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : "application/octet-stream";
}
