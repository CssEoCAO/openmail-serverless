export interface SendEmailAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes. */
  content: ArrayBuffer | Uint8Array;
}

export interface SendEmailParams {
  from: string;
  to: string;
  /** SMTP envelope recipient when it differs from the visible MIME To/Cc. */
  envelopeTo?: string;
  /** Optional CC list — each entry can be a bare address or "Name <addr>". */
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
  /** Provider-supported stable de-duplication key for retries. */
  idempotencyKey?: string;
}

export interface SendEmailError {
  message: string;
  /**
   * true = worth retrying via the outbox (429/5xx/quota/network);
   * false = terminal reject (bad recipient, auth failure).
   */
  transient: boolean;
  /**
   * The transport was invoked but no authoritative response was received.
   * Providers without an idempotency key must not automatically retry this
   * result because the first request may already have been accepted.
   */
  ambiguous?: boolean;
}

export interface SendEmailResult {
  id: string | null;
  error: SendEmailError | null;
}

export interface EmailSender {
  provider:
    | "resend"
    | "cloudflare"
    | "routed"
    | "none"
    | "demo"
    | "bavimail"
    | "postmark";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  maxAttachmentBytes(): number;
}
