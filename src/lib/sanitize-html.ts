import DOMPurify from "dompurify";

// Ensure all links in sanitized email HTML open in a new tab safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // This HTML is inserted into the authenticated document. Keep text and
    // basic formatting, but no CSS, forms, embeds or automatic network loads.
    ALLOWED_TAGS: [
      "a",
      "p",
      "br",
      "div",
      "span",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "hr",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
