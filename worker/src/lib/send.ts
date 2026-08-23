import { isSuppressed, type Database } from "./suppressions";
import { signToken } from "./unsubscribe-token";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "./email-sender";
import { encodeDisplayName, sanitizeHeaderValue } from "./format-from-address";
import { assertFitsD1EmailTextBudget } from "./email-limits";

/**
 * A CC entry the caller hands us. We need the bare `email` for suppression
 * lookups AND for per-recipient token signing; the optional `name` is only
 * used when we format the final `"Name <addr>"` header value for the wire.
 */
export interface CcRecipient {
  email: string;
  name?: string | null;
}

export interface SendInput {
  db: Database;
  env: { UNSUBSCRIBE_SECRET: string; BASE_URL: string };
  sender: EmailSender;
  from: SendEmailParams["from"];
  to: string;
  /** Single durable SMTP envelope recipient; visible To/Cc stay unchanged. */
  envelopeTo?: string;
  cc?: CcRecipient[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailParams["attachments"];
  transactional?: boolean;
  /** Stable provider de-duplication key for a single transport unit. */
  idempotencyKey?: string;
  /** Display name when a CC recipient is promoted to an individual send. */
  toName?: string | null;
  /** Persist the exact canonical wire payload before the provider side effect. */
  onPrepared?: (params: SendEmailParams) => Promise<void>;
  /** Last-moment fencing hook, invoked immediately before sender.send. */
  beforeSend?: () => Promise<void>;
}

export interface SendOutput {
  /** Recipients whose provider accepted the message in this invocation. */
  delivered: string[];
  /**
   * Non-suppressed recipients for which transport was attempted, including
   * transient/permanent/ambiguous results. Outbox callers use this for audit
   * ownership without falsely exposing a pending recipient as delivered.
   */
  attempted?: string[];
  suppressed: string[];
  result?: SendEmailResult;
  /**
   * For audit logging: the rendered html/text actually sent to the FIRST
   * delivered recipient. For multi-recipient marketing sends each recipient
   * gets their own per-recipient token, so this is a representative copy of
   * one wire payload, not all of them.
   */
  renderedHtml?: string;
  renderedText?: string;
}

const UNSUB_PLACEHOLDER = /\{\{unsubscribe_url\}\}/g;

/** A fencing guard proved the durable send was cancelled before transport. */
export class SendAbortedError extends Error {
  constructor(message = "Send was cancelled before transport") {
    super(message);
    this.name = "SendAbortedError";
  }
}

function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/unsubscribe?token=${encodeURIComponent(
    token,
  )}`;
}

function appendHtmlFooter(html: string, url: string): string {
  return (
    html +
    `<hr/>\n<p style="font-size:12px;color:#666"><a href="${url}">Unsubscribe</a></p>`
  );
}

function appendTextFooter(text: string, url: string): string {
  return text + `\n\n---\nUnsubscribe: ${url}`;
}

/** Format a CcRecipient as a header-friendly `"Name <addr>"` string. */
function formatCcForTransport(c: CcRecipient): string {
  if (!c.name) return c.email;
  const name = encodeDisplayName(c.name);
  return name ? `${name} <${c.email}>` : c.email;
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sanitizeHeaderValue(value),
    ]),
  );
}

export async function sendWithSuppressionCheck(
  input: SendInput,
): Promise<SendOutput> {
  const {
    db,
    env,
    sender,
    from,
    to,
    envelopeTo,
    cc,
    subject,
    html,
    text,
    headers,
    attachments,
    transactional,
    idempotencyKey,
    toName,
    onPrepared,
    beforeSend,
  } = input;
  const wireSubject = sanitizeHeaderValue(subject);
  const wireHeaders = sanitizeHeaders(headers);

  // Partition recipients into delivered vs suppressed. Transactional sends
  // bypass the suppression list entirely.
  let primaryTo: string | null;
  const deliveredCc: CcRecipient[] = [];
  const suppressed: string[] = [];

  if (transactional === true) {
    primaryTo = to;
    if (cc && cc.length > 0) deliveredCc.push(...cc);
  } else {
    primaryTo = (await isSuppressed(db, to)) ? null : to;
    if (primaryTo === null) suppressed.push(to);

    if (cc) {
      for (const entry of cc) {
        if (await isSuppressed(db, entry.email)) {
          suppressed.push(entry.email);
        } else {
          deliveredCc.push(entry);
        }
      }
    }
  }

  // Nothing to send if every recipient was suppressed.
  if (primaryTo === null) {
    return { delivered: [], suppressed };
  }

  let lastResult: SendEmailResult | undefined;
  let renderedHtml: string | undefined;
  let renderedText: string | undefined;

  if (transactional === true) {
    // Transactional: single transport call, no per-recipient personalization,
    // no List-Unsubscribe headers, no footer auto-append.
    const ccArg =
      deliveredCc.length > 0
        ? deliveredCc.map(formatCcForTransport)
        : undefined;

    assertFitsD1EmailTextBudget(
      from,
      primaryTo,
      ccArg ? JSON.stringify(ccArg) : null,
      wireSubject,
      html,
      text,
      wireHeaders ? JSON.stringify(wireHeaders) : null,
    );

    const wireParams: SendEmailParams = {
      from,
      to: toName
        ? formatCcForTransport({ email: primaryTo, name: toName })
        : primaryTo,
      ...(envelopeTo ? { envelopeTo } : {}),
      ...(ccArg ? { cc: ccArg } : {}),
      subject: wireSubject,
      html: html ?? "",
      ...(text !== undefined ? { text } : {}),
      ...(wireHeaders ? { headers: wireHeaders } : {}),
      ...(attachments ? { attachments } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    await onPrepared?.(wireParams);
    await beforeSend?.();
    lastResult = await sender.send(wireParams);

    renderedHtml = html;
    renderedText = text;
  } else {
    // Marketing: one transport call per delivered recipient, each with its
    // own per-recipient unsubscribe token + headers + body interpolation.
    // Every recipient sees themselves as the sole `to` (no cc list), so
    // clicking the unsubscribe link suppresses them — not somebody else.
    const allDelivered: Array<{ email: string; cc?: CcRecipient }> = [
      { email: primaryTo },
      ...deliveredCc.map((c) => ({ email: c.email, cc: c })),
    ];

    const results = await Promise.all(
      allDelivered.map(async (recipient) => {
        const token = await signToken(recipient.email, env.UNSUBSCRIBE_SECRET);
        const url = buildUnsubscribeUrl(env.BASE_URL, token);

        let recipientHtml = html;
        let recipientText = text;
        if (typeof recipientHtml === "string") {
          recipientHtml = recipientHtml.replace(UNSUB_PLACEHOLDER, url);
          if (!recipientHtml.includes(url)) {
            recipientHtml = appendHtmlFooter(recipientHtml, url);
          }
        }
        if (typeof recipientText === "string") {
          recipientText = recipientText.replace(UNSUB_PLACEHOLDER, url);
          if (!recipientText.includes(url)) {
            recipientText = appendTextFooter(recipientText, url);
          }
        }

        const recipientHeaders: Record<string, string> = {
          ...(wireHeaders ?? {}),
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        };

        // The header-formatted "to" is `"Name <addr>"` only when this entry
        // came from a cc with a display name; the original `to` is a bare
        // string by signature.
        const toForTransport = recipient.cc
          ? formatCcForTransport(recipient.cc)
          : toName
            ? formatCcForTransport({ email: recipient.email, name: toName })
            : recipient.email;

        assertFitsD1EmailTextBudget(
          from,
          toForTransport,
          wireSubject,
          recipientHtml,
          recipientText,
          JSON.stringify(recipientHeaders),
        );

        const wireParams: SendEmailParams = {
          from,
          to: toForTransport,
          subject: wireSubject,
          html: recipientHtml ?? "",
          ...(recipientText !== undefined ? { text: recipientText } : {}),
          headers: recipientHeaders,
          ...(attachments ? { attachments } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        await onPrepared?.(wireParams);
        await beforeSend?.();
        const result = await sender.send(wireParams);

        return { result, recipientHtml, recipientText };
      }),
    );

    lastResult = results[0].result;
    renderedHtml = results[0].recipientHtml;
    renderedText = results[0].recipientText;
  }

  return {
    delivered:
      transactional === true && envelopeTo
        ? [envelopeTo]
        : [primaryTo, ...deliveredCc.map((c) => c.email)],
    suppressed,
    result: lastResult,
    ...(renderedHtml !== undefined ? { renderedHtml } : {}),
    ...(renderedText !== undefined ? { renderedText } : {}),
  };
}
