-- The bounded activity transaction is an independently metered provider call
-- inside one assistant request. Give it a distinct source so it cannot collide
-- with the main-agent row under the (request_id, user_id, source) key.
ALTER TABLE minutka_private.usage DROP CONSTRAINT usage_source_check;
ALTER TABLE minutka_private.usage
  ADD CONSTRAINT usage_source_check
  CHECK (source IN ('chat', 'activity_transaction', 'onboarding', 'summarization', 'guard'));
