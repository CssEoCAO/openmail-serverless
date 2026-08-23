import PostalMime from "postal-mime";
import { sanitizeHeaderValue } from "./format-from-address";
import { sanitizeContentType } from "./sanitize-content-type";

export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface ParsedEmailAddress {
  email: string;
  name: string | null;
}

export interface ParsedEmail {
  from: { address: string; name: string };
  to: string;
  /** Additional recipients on the Cc: line, parsed from the MIME headers. */
  cc: ParsedEmailAddress[];
  subject: string;
  /** Quote-trimmed HTML body, with `cid:` refs left intact. For display/storage. */
  bodyHtml: string | null;
  /** Quote-trimmed plain-text body. For display/storage. */
  bodyText: string | null;
  /**
   * Untrimmed HTML body, exactly as received. Used when relaying the message
   * onward (per-inbox forwarding), where dropping the quoted reply history
   * would lose context the recipient needs.
   */
  fullBodyHtml: string | null;
  /** Untrimmed plain-text body, exactly as received. See `fullBodyHtml`. */
  fullBodyText: string | null;
  messageId: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
  auth: AuthResults;
  spamScore: number | null;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId: string | null;
  disposition: string | null;
}

/**
 * Trim quoted reply content from plain text email bodies.
 * Removes lines starting with ">" and common quote headers like
 * "On Mon, Jan 1, 2024 at 10:00 AM ... wrote:" that email clients
 * append when replying.
 */
export function trimQuotedText(text: string): string {
  const lines = text.split("\n");
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Line starts with ">" — quoted content
    if (line.startsWith(">")) {
      // Check if previous non-empty line is a quote header like "On ... wrote:"
      if (i > 0 && /^On .+ wrote:$/i.test(lines[i - 1].trim())) {
        cutIndex = i - 1;
      } else {
        cutIndex = i;
      }
      break;
    }

    // Gmail/Apple-style separator
    if (
      /^On .+ wrote:$/i.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line) ||
      line === "________________________________________"
    ) {
      cutIndex = i;
      break;
    }
  }

  return lines.slice(0, cutIndex).join("\n").trimEnd();
}

/**
 * Trim quoted reply content from HTML email bodies.
 * Removes common wrapper elements that email clients use:
 * - Gmail: <div class="gmail_quote">
 * - Apple Mail / Outlook: <blockquote>
 * - Generic: elements with class containing "quote" or "moz-cite-prefix"
 */
export function trimQuotedHtml(html: string): string {
  // Gmail quote block
  let trimmed = html.replace(/<div\s+class="gmail_quote"[\s\S]*$/i, "");

  // Yahoo quote header + blockquote
  trimmed = trimmed.replace(/<div\s+id="yahoo_quoted_[\s\S]*$/i, "");

  // Outlook-style "Original Message" separator and everything after
  trimmed = trimmed.replace(
    /<div\s[^>]*style="border:none;border-top:solid #[A-Fa-f0-9]+ 1\.0pt[\s\S]*$/i,
    "",
  );

  // Generic blockquote at the end (Apple Mail, Thunderbird)
  trimmed = trimmed.replace(/<div\s+class="moz-cite-prefix"[\s\S]*$/i, "");

  return trimmed.trimEnd();
}

type ParsedHeader = { key: string; value: string };

function authVerdict(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`(?:^|[;\\s])${key}=([a-zA-Z]+)`, "i"));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parse only Cloudflare's authentication verdict and require DMARC alignment
 * with the visible RFC5322 From domain. A sender can include arbitrary
 * Authentication-Results headers in the MIME input; treating any such header
 * (or an unaligned SPF/DKIM pass) as identity proof lets a forged From mutate
 * another contact and cancel their sequence.
 *
 * Multiple Cloudflare-shaped headers are evaluated conservatively: every one
 * must report an aligned DMARC pass. That prevents a prepended spoofed "pass"
 * from overriding the receiver's real failure result when headers repeat.
 */
export function parseTrustedAuthResults(
  headers: readonly ParsedHeader[],
  fromAddress: string,
): AuthResults {
  const trusted = headers
    .filter((header) => {
      const key = header.key.toLowerCase();
      if (
        key !== "authentication-results" &&
        key !== "arc-authentication-results"
      ) {
        return false;
      }
      return /^\s*(?:i\s*=\s*\d+\s*;\s*)?mx\.cloudflare\.net\s*;/i.test(
        header.value,
      );
    })
    .map((header) => header.value);

  if (trusted.length === 0) {
    return { spf: null, dkim: null, dmarc: null };
  }

  const fromDomain = fromAddress
    .slice(fromAddress.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const alignedDmarcPass = trusted.every((raw) => {
    const headerFrom = raw
      .match(/(?:^|[;\s])header\.from=("[^"]+"|[^;\s]+)/i)?.[1]
      ?.replace(/^"|"$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    return authVerdict(raw, "dmarc") === "pass" && headerFrom === fromDomain;
  });

  const first = trusted[0];
  return {
    spf: authVerdict(first, "spf"),
    dkim: authVerdict(first, "dkim"),
    dmarc: alignedDmarcPass
      ? "pass"
      : (trusted
          .map((raw) => authVerdict(raw, "dmarc"))
          .find((verdict) => verdict !== null && verdict !== "pass") ?? "fail"),
  };
}

function parseSpamScore(headers: Record<string, string>): number | null {
  const raw = headers["x-spam-score"] ?? headers["X-Spam-Score"];
  if (!raw) return null;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : null;
}

export async function parseEmail(
  message: ForwardableEmailMessage,
): Promise<ParsedEmail> {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const header of parsed.headers) {
      headers[header.key] = header.value;
    }
  }

  const bodyText = parsed.text || null;
  const bodyHtml = parsed.html || null;
  const fromAddress = parsed.from?.address || message.from;

  // Extract CC list from the parsed MIME structure. postal-mime exposes
  // `parsed.cc` as an array of `{ address, name }` (or undefined). We
  // - filter to entries with a syntactically-valid email (don't trust
  //   header data — malformed Cc: lines pollute displayed rosters
  //   and the de-dupe-by-email logic elsewhere),
  // - lowercase the address so casing variants of the same recipient
  //   don't fork conversation_id buckets,
  // - cap the array so a single inbound message can't slam storage
  //   with thousands of header-entries.
  const cc: ParsedEmailAddress[] = (
    (parsed.cc as Array<{ address?: string; name?: string }> | undefined) ?? []
  )
    .filter((c): c is { address: string; name?: string } => {
      if (!c.address || typeof c.address !== "string") return false;
      // Cheap RFC 5322-ish gate. Defers strict validation to downstream
      // schemas; we only need to reject the obviously-not-email cases.
      return /^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(c.address.trim());
    })
    .slice(0, 50)
    .map((c) => ({
      email: c.address.trim().toLowerCase(),
      name: c.name && c.name.trim() ? c.name.trim().slice(0, 200) : null,
    }));

  return {
    from: {
      address: fromAddress,
      name: sanitizeHeaderValue(parsed.from?.name || "", 200),
    },
    to: message.to,
    cc,
    subject: sanitizeHeaderValue(parsed.subject || ""),
    bodyHtml: bodyHtml ? trimQuotedHtml(bodyHtml) : null,
    bodyText: bodyText ? trimQuotedText(bodyText) : null,
    fullBodyHtml: bodyHtml,
    fullBodyText: bodyText,
    messageId: parsed.messageId
      ? sanitizeHeaderValue(parsed.messageId, 998) || null
      : null,
    headers,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || "unnamed",
      contentType: sanitizeContentType(att.mimeType),
      content: att.content,
      // Content-ID becomes both a RegExp input and a D1 field downstream.
      // RFC header lines are bounded to 998 octets; cap the parsed value too
      // because PostalMime does not include part headers in our top-level
      // rawHeaders budget.
      contentId: att.contentId
        ? sanitizeHeaderValue(att.contentId, 998) || null
        : null,
      disposition: att.disposition || null,
    })),
    auth: parseTrustedAuthResults(parsed.headers ?? [], fromAddress),
    spamScore: parseSpamScore(headers),
  };
}
