import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { parseFrom } from "../shared";

export type IdentityOutboundProvider = "cloudflare" | "resend";
export type IdentityProviderResolver = (
  fromAddress: string,
) => Promise<IdentityOutboundProvider>;

interface IdentityProviderSenders {
  cloudflare?: EmailSender;
  resend?: EmailSender;
}

/**
 * Selects the transport from the sender identity instead of applying one
 * global provider to every domain. A selected-but-unconfigured provider fails
 * closed; it never falls back to the other transport and changes reputation,
 * quotas, or billing silently.
 */
export class IdentityRoutedSender implements EmailSender {
  readonly provider = "routed" as const;

  constructor(
    private readonly senders: IdentityProviderSenders,
    private readonly resolveProvider: IdentityProviderResolver,
  ) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const address = parseFrom(params.from).address.trim().toLowerCase();
    const provider = await this.resolveProvider(address);
    const sender = this.senders[provider];
    if (!sender) {
      const requirement =
        provider === "resend" ? "RESEND_API_KEY" : "EMAIL binding";
      return {
        id: null,
        error: {
          message: `${provider} is selected for ${address}, but ${requirement} is not configured`,
          transient: false,
        },
      };
    }
    return sender.send(params);
  }

  maxAttachmentBytes(): number {
    const limits = Object.values(this.senders).map((sender) =>
      sender.maxAttachmentBytes(),
    );
    return limits.length > 0 ? Math.min(...limits) : 0;
  }
}
