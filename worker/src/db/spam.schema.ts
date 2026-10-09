import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * E-mail recebido que foi para o Spam. Mora fora de `emails` de propósito: as
 * dezenas de consultas da caixa (lista, contagens, busca, MCP) leem `emails` e
 * nenhuma precisa lembrar de filtrar spam. Guarda tudo o que "Não é spam" precisa
 * para devolver a mensagem intacta, com o mesmo id (os anexos no R2 já usam a
 * chave `attachments/<id>/...`). Apagado sozinho depois de 30 dias.
 */
export const spamEmails = sqliteTable(
  "spam_emails",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    rawHeaders: text("raw_headers"),
    messageId: text("message_id"),
    spf: text("spf"),
    dkim: text("dkim"),
    dmarc: text("dmarc"),
    cc: text("cc"),
    conversationId: text("conversation_id"),
    /** JSON: [{ id, filename, contentType, size, r2Key, contentId }] */
    attachments: text("attachments"),
    /** golpe | prospeccao | bloqueio | reincidente */
    category: text("category").notNull(),
    reason: text("reason"),
    /** Confiança da IA (0–1); null quando a decisão não foi da IA. */
    confidence: real("confidence"),
    receivedAt: integer("received_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("spam_emails_message_recipient_unique").on(
      table.messageId,
      table.recipient,
    ),
    index("spam_emails_recipient_received_idx").on(
      table.recipient,
      table.receivedAt,
    ),
    index("spam_emails_from_idx").on(table.fromAddress),
  ],
);

/** Admin confia globalmente (*); membro libera apenas a caixa restaurada. */
export const trustedSenders = sqliteTable(
  "trusted_senders",
  {
    email: text("email").notNull(),
    recipient: text("recipient").notNull().default("*"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.email, table.recipient] })],
);

export type SpamEmail = typeof spamEmails.$inferSelect;
