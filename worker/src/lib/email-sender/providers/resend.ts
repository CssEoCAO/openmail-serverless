import { Resend } from "resend";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { toBase64 } from "../shared";
import { classifyErrorMessage } from "../classify";

export class ResendSender implements EmailSender {
  readonly provider = "resend" as const;
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    // Resend drops a Reply-To passed in `headers` (seen on a forwarded copy:
    // the X- headers arrived, Reply-To did not), so it goes in `replyTo`.
    const headers = { ...params.headers };
    let replyTo: string | undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "reply-to") {
        replyTo = headers[key];
        delete headers[key];
      }
    }
    const result = await this.client.emails.send(
      {
        from: params.from,
        to: params.to,
        ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
        subject: params.subject,
        html: params.html,
        text: params.text,
        ...(replyTo ? { replyTo } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(params.attachments && params.attachments.length > 0
          ? {
              attachments: params.attachments.map((a) => ({
                filename: a.filename,
                content: toBase64(a.content),
              })),
            }
          : {}),
      },
      params.idempotencyKey
        ? { idempotencyKey: params.idempotencyKey }
        : undefined,
    );
    if (result.error) {
      const message = result.error.message ?? "Resend send failed";
      return {
        id: null,
        error: {
          message,
          transient: classifyErrorMessage(
            `${result.error.name ?? ""} ${message}`,
          ),
        },
      };
    }
    return { id: result.data?.id ?? null, error: null };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }
}
