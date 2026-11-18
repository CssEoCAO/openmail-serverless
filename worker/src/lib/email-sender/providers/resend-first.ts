import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";

/**
 * Transport for identities whose outbound provider is `cloudflare` when a
 * Resend key is also configured: Resend first, Cloudflare Email Sending as the
 * reserve.
 *
 * Why: Cloudflare Email Sending delivers from shared IPs, and a mailbox
 * provider that throttles those IPs on reputation (Microsoft's Outlook /
 * Hotmail / Live answer `451 4.7.650 ... rate limited due to IP reputation`)
 * stops accepting that mail no matter how clean the sending domain is.
 *
 * Rules:
 * - Resend accepted (no error) → done; the binding is not touched.
 * - Resend refused (any error result: 4xx such as an unverified sender domain,
 *   429, 5xx, or a network failure reported by the SDK) or threw → log and send
 *   the exact same params through Cloudflare, unchanged.
 * - A single SMTP envelope recipient (`envelopeTo`) has no Resend equivalent
 *   (Resend delivers to every visible To/Cc address), so those units go to
 *   Cloudflare directly.
 *
 * It reports `provider = "cloudflare"` on purpose: the outbox snapshots the
 * identity's provider and keeps the conservative Cloudflare retry semantics
 * (an ambiguous result is held for manual review, never auto-duplicated).
 */
export class ResendFirstSender implements EmailSender {
  readonly provider = "cloudflare" as const;

  constructor(
    private readonly resend: EmailSender,
    private readonly cloudflare: EmailSender,
  ) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    if (!params.envelopeTo) {
      try {
        const result = await this.resend.send(params);
        if (!result.error) return result;
        console.error(
          `[email:resend] refused, falling back to Cloudflare: ${result.error.message}`.slice(
            0,
            300,
          ),
        );
      } catch (err) {
        console.error(
          "[email:resend] failed, falling back to Cloudflare:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return this.cloudflare.send(params);
  }

  maxAttachmentBytes(): number {
    // The message may end up on either transport.
    return Math.min(
      this.resend.maxAttachmentBytes(),
      this.cloudflare.maxAttachmentBytes(),
    );
  }
}
