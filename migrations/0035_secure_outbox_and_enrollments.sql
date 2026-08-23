ALTER TABLE `outbox_emails` ADD `wire_from` text;
--> statement-breakpoint
ALTER TABLE `outbox_emails` ADD `wire_to` text;
--> statement-breakpoint
ALTER TABLE `outbox_emails` ADD `wire_cc` text;
--> statement-breakpoint
ALTER TABLE `outbox_emails` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `outbox_emails` ADD `provider_message_id` text;
--> statement-breakpoint
CREATE INDEX `outbox_sent_email_idx` ON `outbox_emails` (`sent_email_id`);
--> statement-breakpoint
CREATE INDEX `outbox_sequence_email_idx` ON `outbox_emails` (`sequence_email_id`);
--> statement-breakpoint
CREATE TRIGGER `push_subscriptions_user_cap`
BEFORE INSERT ON `push_subscriptions`
WHEN (SELECT COUNT(*) FROM `push_subscriptions` WHERE `user_id` = NEW.`user_id`) >= 10
BEGIN
  SELECT RAISE(ABORT, 'push subscription limit');
END;
--> statement-breakpoint
UPDATE `sequence_emails`
SET `status` = 'cancelled'
WHERE (
    `status` IN ('pending', 'queued', 'retrying')
    OR `status` LIKE 'processing:%'
  )
  AND `enrollment_id` IN (
  SELECT newer.`id`
  FROM `sequence_enrollments` AS newer
  WHERE newer.`status` = 'active'
    AND EXISTS (
      SELECT 1
      FROM `sequence_enrollments` AS older
      WHERE older.`person_id` = newer.`person_id`
        AND older.`status` = 'active'
        AND (
          older.`enrolled_at` < newer.`enrolled_at`
          OR (older.`enrolled_at` = newer.`enrolled_at` AND older.`id` < newer.`id`)
        )
    )
);
--> statement-breakpoint
UPDATE `outbox_emails`
SET `status` = 'failed', `last_error` = 'Duplicate active enrollment removed during migration'
WHERE `status` = 'pending'
  AND `sequence_email_id` IN (
    SELECT `id` FROM `sequence_emails` WHERE `status` = 'cancelled'
  );
--> statement-breakpoint
UPDATE `sent_emails`
SET `status` = 'failed'
WHERE `status` = 'retrying'
  AND `id` IN (
    SELECT `sent_email_id`
    FROM `outbox_emails`
    WHERE `status` = 'failed'
      AND `last_error` = 'Duplicate active enrollment removed during migration'
  );
--> statement-breakpoint
UPDATE `sequence_enrollments` AS newer
SET `status` = 'cancelled', `cancelled_at` = unixepoch()
WHERE newer.`status` = 'active'
  AND EXISTS (
    SELECT 1
    FROM `sequence_enrollments` AS older
    WHERE older.`person_id` = newer.`person_id`
      AND older.`status` = 'active'
      AND (
        older.`enrolled_at` < newer.`enrolled_at`
        OR (older.`enrolled_at` = newer.`enrolled_at` AND older.`id` < newer.`id`)
      )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_one_active_person_idx` ON `sequence_enrollments` (`person_id`) WHERE `status` = 'active';
