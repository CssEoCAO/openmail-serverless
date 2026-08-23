import { EmailMessage } from "cloudflare:email";
// The `browser` entrypoint, not the default `node` one: the node build pulls in
// `mime-types`, a CJS package that fails to load in the Workers runtime
// ("require is not defined"). Workers has no Node builtins, so the browser
// build is the correct target. The only behavioral difference is that
// attachment Content-Type validation becomes permissive.
import { createMimeMessage, Mailbox } from "mimetext/browser";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { parseFrom, toBase64 } from "../shared";
import { classifyErrorMessage } from "../classify";

export class CloudflareSender implements EmailSender {
  readonly provider = "cloudflare" as const;
  constructor(private binding: SendEmail) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    let transportStarted = false;
    try {
      const { name, address } = parseFrom(params.from);
      const msg = createMimeMessage();
      msg.setSender(name ? { name, addr: address } : { addr: address });
      msg.setRecipient(params.to);
      const visibleTo = parseFrom(params.to).address.toLowerCase();
      const seenVisible = new Set([visibleTo]);
      const visibleCc = (params.cc ?? [])
        .map((recipient) => parseFrom(recipient))
        .filter((recipient) => {
          const canonical = recipient.address.toLowerCase();
          if (seenVisible.has(canonical)) return false;
          seenVisible.add(canonical);
          return true;
        });
      if (visibleCc.length > 0) {
        // Repeated setCc calls replace the preceding header in mimetext.
        msg.setCc(
          visibleCc.map((recipient) =>
            recipient.name
              ? { name: recipient.name, addr: recipient.address }
              : { addr: recipient.address },
          ),
        );
      }
      msg.setSubject(params.subject);
      if (params.text) {
        msg.addMessage({ contentType: "text/plain", data: params.text });
      }
      if (params.html) {
        msg.addMessage({ contentType: "text/html", data: params.html });
      }
      if (params.attachments) {
        for (const a of params.attachments) {
          msg.addAttachment({
            filename: a.filename,
            contentType: a.contentType,
            data: toBase64(a.content),
          });
        }
      }
      if (params.headers) {
        for (const [key, value] of Object.entries(params.headers)) {
          // Reply-To is a predefined address-type header in mimetext, so a bare
          // string fails its mailbox validate/dump (unlike plain headers like
          // Message-ID / In-Reply-To). Wrap it in a Mailbox so it serializes.
          if (key.toLowerCase() === "reply-to") {
            // mimetext defines Reply-To as a single-mailbox header
            // (validateMailboxSingle), so it needs one Mailbox, not an array.
            msg.setHeader(key, new Mailbox(value));
          } else {
            msg.setHeader(key, value);
          }
        }
      }
      const raw = msg.asRaw();
      // EmailMessage's `to` is the singular SMTP envelope recipient; MIME Cc
      // only controls display/Reply-All and is not a delivery instruction.
      // Submit the same visible To/Cc payload once for every unique envelope
      // recipient so Cc works without changing the conversation headers.
      const envelopeRecipients = (
        params.envelopeTo
          ? [params.envelopeTo]
          : [params.to, ...visibleCc.map((recipient) => recipient.address)]
      )
        .map((recipient) => parseFrom(recipient).address)
        .filter(
          (recipient, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.toLowerCase() === recipient.toLowerCase(),
            ) === index,
        );
      let messageId: string | null = null;
      for (const recipient of envelopeRecipients) {
        const message = new EmailMessage(address, recipient, raw);
        transportStarted = true;
        const result = await this.binding.send(message);
        messageId ??= result?.messageId ?? null;
      }
      return { id: messageId, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Surface the cause: this path was previously swallowed, making send
      // failures invisible in logs and the API response.
      console.error(
        "[CloudflareSender] send failed:",
        message,
        e instanceof Error ? e.stack : "",
      );
      return {
        id: null,
        error: {
          message,
          transient: classifyErrorMessage(message),
          ...(transportStarted ? { ambiguous: true } : {}),
        },
      };
    }
  }

  maxAttachmentBytes(): number {
    return Math.floor((25 * 1024 * 1024) / 1.4);
  }
}
