CREATE TABLE `reply_drafts` (
	`user_id` text NOT NULL,
	`email_id` text NOT NULL,
	`from_address` text NOT NULL,
	`cc` text,
	`body_html` text NOT NULL,
	`body_text` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `email_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reply_drafts_user_idx` ON `reply_drafts` (`user_id`);