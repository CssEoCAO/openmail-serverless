CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`context_key` text NOT NULL,
	`from_address` text,
	`to_address` text,
	`cc` text,
	`subject` text,
	`body_html` text,
	`body_text` text,
	`reply_to_email_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_user_context_idx` ON `drafts` (`user_id`,`context_key`);--> statement-breakpoint
CREATE TABLE `gmail_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email_address` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`access_token` text,
	`expires_at` integer,
	`history_id` text,
	`last_synced_at` integer,
	`last_error` text,
	`last_gap_at` integer,
	`backfill_until` integer,
	`backfill_page_token` text,
	`backfill_offset` integer DEFAULT 0 NOT NULL,
	`backfill_count` integer DEFAULT 0 NOT NULL,
	`backfill_completed_at` integer,
	`connected_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_accounts_email_address_unique` ON `gmail_accounts` (`email_address`);--> statement-breakpoint
ALTER TABLE `emails` ADD `gmail_message_id` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `gmail_thread_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `gmail_message_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `gmail_thread_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_gmail_message_from_unique` ON `sent_emails` (`gmail_message_id`,`from_address`);--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `source` text DEFAULT 'cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_account_id` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_group_address` text;