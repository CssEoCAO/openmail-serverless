-- Data backfill (no schema change): one table for drafts.
-- reply_drafts (this fork, 0037) -> drafts (upstream, 0040).
-- context_key = 'reply:' || email_id, reply_to_email_id = email_id, created_at = updated_at.
-- Idempotent: a draft already autosaved by the new UI under the same key wins.
-- reply_drafts is dropped in 0042, separately, so a failed copy deletes nothing.
INSERT INTO `drafts` (
  `id`, `user_id`, `context_key`, `from_address`, `to_address`, `cc`, `subject`,
  `body_html`, `body_text`, `reply_to_email_id`, `created_at`, `updated_at`
)
SELECT
  lower(hex(randomblob(16))), `user_id`, 'reply:' || `email_id`, `from_address`, NULL, `cc`, NULL,
  `body_html`, `body_text`, `email_id`, `updated_at`, `updated_at`
FROM `reply_drafts`
WHERE true
ON CONFLICT(`user_id`, `context_key`) DO NOTHING;
