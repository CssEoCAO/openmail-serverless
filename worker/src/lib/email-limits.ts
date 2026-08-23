// D1 caps both a string and an entire table row at 2,000,000 bytes. Leave
// headroom for ids, timestamps, SQLite record overhead, and the unsubscribe
// footer that can be appended immediately before transport.
export const MAX_D1_EMAIL_TEXT_BYTES = 1_750_000;

/** Return the combined UTF-8 byte length of nullable email text fields. */
export function emailTextBytes(
  ...values: Array<string | null | undefined>
): number {
  const encoder = new TextEncoder();
  return values.reduce(
    (total, value) =>
      total + (value == null ? 0 : encoder.encode(value).byteLength),
    0,
  );
}

/** Whether a set of fields safely fits a D1-backed email/outbox row. */
export function fitsD1EmailTextBudget(
  ...values: Array<string | null | undefined>
): boolean {
  return emailTextBytes(...values) <= MAX_D1_EMAIL_TEXT_BYTES;
}

export const EMAIL_CONTENT_TOO_LARGE_MESSAGE =
  "Email content exceeds the storage limit";

/** Typed failure so API and Queue callers can fail closed without a 500 loop. */
export class EmailContentTooLargeError extends RangeError {
  constructor() {
    super(EMAIL_CONTENT_TOO_LARGE_MESSAGE);
    this.name = "EmailContentTooLargeError";
  }
}

/** Assert after every render/rewrite that the exact wire fields still fit. */
export function assertFitsD1EmailTextBudget(
  ...values: Array<string | null | undefined>
): void {
  if (!fitsD1EmailTextBudget(...values)) {
    throw new EmailContentTooLargeError();
  }
}
