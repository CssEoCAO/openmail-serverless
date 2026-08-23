ALTER TABLE `sender_identities` ADD `outbound_provider` text DEFAULT 'cloudflare' NOT NULL;
--> statement-breakpoint
UPDATE `sender_identities`
SET `outbound_provider` = 'resend'
WHERE lower(`email`) IN (
  'support@example.com',
  'billing@notify.example.com'
);
