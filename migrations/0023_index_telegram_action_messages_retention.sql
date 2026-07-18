-- Supports the hourly retention sweep without scanning every action claim.
CREATE INDEX telegram_action_messages_claimed_at_idx
  ON minutka_private.telegram_action_messages (claimed_at);
