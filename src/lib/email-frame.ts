import DOMPurify from "dompurify";
import type { Attachment } from "@/lib/api";

/**
 * Builds the document rendered inside `EmailHtmlFrame`'s sandboxed iframe.
 *
 * The frame is the trust boundary: it has no scripts (sandbox without
 * `allow-scripts`) and its own CSP, so — unlike `sanitizeEmailHtml`, which
 * inlines into the authenticated document — the email keeps its CSS, tables,
 * images and `<head><style>`, i.e. it looks like the original. DOMPurify still
 * runs as defence in depth (scripts, forms, embeds and event handlers out).
 */

// Own instance so this module's hook never leaks into `sanitize-html.ts`.
const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    // Links open a new tab outside the sandbox; noopener keeps the opened
    // page from navigating this frame (it is same-origin with the app).
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Inserted right after <head> so the email's own <style> still wins.
const FRAME_HEAD =
  '<meta charset="utf-8">' +
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src * data:\">" +
  '<meta name="viewport" content="width=device-width">' +
  "<style>" +
  "html,body{margin:0}" +
  "body{padding:12px 16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;overflow-wrap:break-word}" +
  "img{max-width:100%;height:auto}" +
  "</style>";

export function buildEmailFrameDoc(
  html: string,
  attachments: Attachment[] = [],
): string {
  // `cid:` references point at inline attachments; the inline route serves
  // them with the session cookie (the frame keeps the app's origin).
  let src = html;
  for (const att of attachments) {
    if (!att.contentId) continue;
    const cid = att.contentId.replace(/^<|>$/g, "");
    src = src.split(`cid:${cid}`).join(`/api/attachments/${att.id}/inline`);
  }

  const clean = purify.sanitize(src, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "meta",
      "link",
      "base",
    ],
    FORBID_ATTR: ["action", "formaction", "srcdoc", "ping"],
    ADD_ATTR: ["target"],
  });

  return clean.includes("<head>")
    ? clean.replace("<head>", "<head>" + FRAME_HEAD)
    : `<!doctype html><html><head>${FRAME_HEAD}</head><body>${clean}</body></html>`;
}
