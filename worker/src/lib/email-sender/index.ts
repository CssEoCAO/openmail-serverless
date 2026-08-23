import { isDemoMode } from "../is-dev";
import type { EmailSender } from "./types";
import { ResendSender } from "./providers/resend";
import { CloudflareSender } from "./providers/cloudflare";
import { BavimailSender } from "./providers/bavimail";
import { PostmarkSender } from "./providers/postmark";
import { NoopSender } from "./providers/noop";
import { DemoSender } from "./providers/demo";
import { IdentityRoutedSender } from "./providers/identity-routed";

export type {
  SendEmailAttachment,
  SendEmailParams,
  SendEmailResult,
  SendEmailError,
  EmailSender,
} from "./types";
export { transientFromStatus, classifyErrorMessage } from "./classify";
export { ResendSender } from "./providers/resend";
export { CloudflareSender } from "./providers/cloudflare";
export { BavimailSender } from "./providers/bavimail";
export { PostmarkSender } from "./providers/postmark";
export { NoopSender } from "./providers/noop";
export { DemoSender } from "./providers/demo";
export {
  IdentityRoutedSender,
  type IdentityOutboundProvider,
  type IdentityProviderResolver,
} from "./providers/identity-routed";

export function createEmailSender(
  env: CloudflareBindings & {
    RESEND_API_KEY?: string;
    EMAIL?: SendEmail;
    BAVIMAIL_API_KEY?: string;
    BAVIMAIL_ALIAS_ID?: string;
    POSTMARK_API_KEY?: string;
    EMAIL_PROVIDER_ROUTING?: string;
  },
): EmailSender {
  if (isDemoMode(env)) {
    return new DemoSender();
  }
  if (env.EMAIL_PROVIDER_ROUTING === "identity") {
    const cloudflare = env.EMAIL ? new CloudflareSender(env.EMAIL) : undefined;
    const resend = env.RESEND_API_KEY
      ? new ResendSender(env.RESEND_API_KEY)
      : undefined;
    return new IdentityRoutedSender(
      { cloudflare, resend },
      async (fromAddress) => {
        const row = await env.DB.prepare(
          "SELECT outbound_provider FROM sender_identities WHERE email = ? LIMIT 1",
        )
          .bind(fromAddress)
          .first<{ outbound_provider: "cloudflare" | "resend" }>();
        return row?.outbound_provider ?? "cloudflare";
      },
    );
  }
  if (env.BAVIMAIL_API_KEY && env.BAVIMAIL_ALIAS_ID) {
    return new BavimailSender(env.BAVIMAIL_API_KEY, env.BAVIMAIL_ALIAS_ID);
  }
  if (env.POSTMARK_API_KEY) {
    return new PostmarkSender(env.POSTMARK_API_KEY);
  }
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}

/** Recreate the concrete provider snapshotted by an outbox unit. */
export function createEmailSenderForProvider(
  env: CloudflareBindings & {
    RESEND_API_KEY?: string;
    EMAIL?: SendEmail;
    BAVIMAIL_API_KEY?: string;
    BAVIMAIL_ALIAS_ID?: string;
    POSTMARK_API_KEY?: string;
  },
  provider: EmailSender["provider"],
): EmailSender {
  switch (provider) {
    case "resend":
      return env.RESEND_API_KEY
        ? new ResendSender(env.RESEND_API_KEY)
        : new NoopSender();
    case "cloudflare":
      return env.EMAIL ? new CloudflareSender(env.EMAIL) : new NoopSender();
    case "bavimail":
      return env.BAVIMAIL_API_KEY && env.BAVIMAIL_ALIAS_ID
        ? new BavimailSender(env.BAVIMAIL_API_KEY, env.BAVIMAIL_ALIAS_ID)
        : new NoopSender();
    case "postmark":
      return env.POSTMARK_API_KEY
        ? new PostmarkSender(env.POSTMARK_API_KEY)
        : new NoopSender();
    case "demo":
      return new DemoSender();
    case "none":
    case "routed":
      return new NoopSender();
  }
}
