import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Write-ahead outbox for outbound sends (issue #151). A row is inserted
 * right before every provider call. A successful provider response becomes a
 * short-lived `sent` marker until permanent history commits; retrying
 * (`pending`) and terminally failed (`failed`) rows remain visible in Outbox.
 */
export const outboxEmails = sqliteTable(
  "outbox_emails",
  {
    id: text("id").primaryKey(),
    /**
     * Pre-generated id shared with the sent_emails row the caller writes.
     * Lets the retry processor flip that row's status and reload its
     * attachments.
     */
    sentEmailId: text("sent_email_id").notNull(),
    /** Set for sequence-step sends so retries can resolve the step too. */
    sequenceEmailId: text("sequence_email_id"),
    /** Bare lowercase inbox address — the inbox-scoping key. */
    fromAddress: text("from_address").notNull(),
    /** Exact formatted From used on the wire. NULL on legacy/prepared rows. */
    wireFrom: text("wire_from"),
    toAddress: text("to_address").notNull(),
    /** Exact formatted To used on the wire. */
    wireTo: text("wire_to"),
    /** JSON [{email,name}] — same shape as sent_emails.cc. NULL = no CC. */
    cc: text("cc"),
    /** Exact provider-formatted CC string array used on the wire. */
    wireCc: text("wire_cc"),
    subject: text("subject").notNull(),
    /** Exact HTML used on the wire after onPrepared; raw only on legacy rows. */
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    /** JSON object. Includes the original Message-ID so every retry reuses it. */
    headers: text("headers"),
    transactional: integer("transactional").notNull().default(0),
    /** Concrete provider selected before the first attempt (never `routed`). */
    provider: text("provider"),
    /** Provider message id retained by sent markers for crash recovery. */
    providerMessageId: text("provider_message_id"),
    /** pending (retryable) | sending (non-idempotent fence) | failed/suppressed/sent (terminal markers). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Unix seconds; the processor picks up pending rows with next_retry_at <= now. */
    nextRetryAt: integer("next_retry_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("outbox_status_retry_idx").on(table.status, table.nextRetryAt),
    index("outbox_from_idx").on(table.fromAddress),
    index("outbox_sent_email_idx").on(table.sentEmailId),
    index("outbox_sequence_email_idx").on(table.sequenceEmailId),
  ],
);
