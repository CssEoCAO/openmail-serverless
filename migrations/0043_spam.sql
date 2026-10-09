CREATE TABLE `spam_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text,
	`subject` text,
	`body_html` text,
	`body_text` text,
	`raw_headers` text,
	`message_id` text,
	`spf` text,
	`dkim` text,
	`dmarc` text,
	`cc` text,
	`conversation_id` text,
	`attachments` text,
	`category` text NOT NULL,
	`reason` text,
	`confidence` real,
	`received_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spam_emails_message_recipient_unique` ON `spam_emails` (`message_id`,`recipient`);--> statement-breakpoint
CREATE INDEX `spam_emails_recipient_received_idx` ON `spam_emails` (`recipient`,`received_at`);--> statement-breakpoint
CREATE INDEX `spam_emails_from_idx` ON `spam_emails` (`from_address`);--> statement-breakpoint
CREATE TABLE `trusted_senders` (
	`email` text NOT NULL,
	`recipient` text DEFAULT '*' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`email`, `recipient`)
);
