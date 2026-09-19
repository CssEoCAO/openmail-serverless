import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Rascunho de resposta, por usuário e por mensagem respondida. Um por par:
 * salvar de novo sobrescreve. Nada aqui é enviado nem agendado — o outbox
 * continua sendo a única fila de saída; isto é só o texto que o usuário ainda
 * não mandou, guardado no servidor para ele retomar de outro aparelho.
 */
export const replyDrafts = sqliteTable(
  "reply_drafts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Id em `emails` (recebido) ou `sent_emails` (nosso), como no /send/reply. */
    emailId: text("email_id").notNull(),
    /** Identidade escolhida em "De:". Validada contra as caixas permitidas ao salvar. */
    fromAddress: text("from_address").notNull(),
    /** JSON [{email,name}] — mesmo formato de `emails.cc`. NULL = sem CC. */
    cc: text("cc"),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    /** Unix segundos. */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.emailId] }),
    index("reply_drafts_user_idx").on(table.userId),
  ],
);
