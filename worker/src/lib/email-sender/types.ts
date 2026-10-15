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
  /**
   * Gmail thread to reply within, instead of starting a new conversation.
   * Optional and Gmail-specific — other providers ignore it.
   */
  threadId?: string;
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
  /**
   * Set when the provider's credentials for this mailbox are dead and a
   * resend of the identical request can never succeed — today, a Gmail grant
   * that was revoked or otherwise no longer refreshes.
   *
   * `transient: false` already says "do not queue this"; this says the
   * stronger thing the USER has to be told, which is that pressing send again
   * is pointless until the mailbox is reconnected.
   */
  reconnect?: boolean;
  /**
   * Set when the provider ACCEPTED the message and the failure is only that
   * we could not record it — today, a Gmail 2xx whose body carried no message
   * id. The mail is on its way to the recipient, so this is the one error on
   * which "send it again" is the wrong advice: it would deliver a second copy
   * of a real reply. A caller wrapping this error in its own sentence must
   * not add a retry instruction; `message` already says what happened.
   */
  delivered?: boolean;
}

export interface SendEmailResult {
  id: string | null;
  /**
   * Gmail's thread id for the message that was just sent — present on a
   * successful Gmail send whether or not a `threadId` was supplied on the
   * request (Gmail assigns a fresh one when it wasn't). Other providers
   * never set this. A reply to a Cloudflare-sourced message has no known
   * thread to pass in, so this is how the caller learns the one Gmail
   * assigned, to persist for later threading.
   */
  threadId?: string | null;
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
    | "postmark"
    | "gmail";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  maxAttachmentBytes(): number;
}
