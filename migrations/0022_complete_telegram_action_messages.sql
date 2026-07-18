ALTER TABLE minutka_private.telegram_action_messages
  ADD COLUMN completed_at timestamptz;

-- Rows created before the lease lifecycle represented completed actions.
-- Preserve their idempotency; only claims created after this migration start incomplete.
UPDATE minutka_private.telegram_action_messages
SET completed_at = claimed_at;

ALTER TABLE minutka_private.telegram_action_messages
  ADD CONSTRAINT telegram_action_messages_completion_order_check CHECK (
    completed_at IS NULL OR completed_at >= claimed_at
  );
