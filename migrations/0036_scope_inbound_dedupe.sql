DROP INDEX IF EXISTS `emails_message_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_message_recipient_unique`
ON `emails` (`message_id`, `recipient`);
--> statement-breakpoint
UPDATE `email_templates`
SET `from_address` = lower(trim(`from_address`))
WHERE `from_address` IS NOT NULL;
