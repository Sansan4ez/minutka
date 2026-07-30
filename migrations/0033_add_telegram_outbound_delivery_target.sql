CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE minutka_private.telegram_sessions
  ADD COLUMN chat_id_encrypted bytea;

COMMENT ON COLUMN minutka_private.telegram_sessions.chat_id_encrypted IS
  'Encrypted Telegram chat id for proactive owner delivery; digest remains the lookup authority.';

-- Existing digest-only sessions cannot be decrypted. Keep their schedules
-- pending operator relink instead of repeatedly invoking the model with no
-- deliverable target. New/redeemed sessions populate the encrypted target.
UPDATE minutka_private.process_schedules AS schedule
SET enabled = false,
    updated_at = now()
WHERE schedule.enabled
  AND NOT EXISTS (
    SELECT 1
    FROM minutka_private.telegram_sessions AS session
    WHERE session.employee_id = schedule.user_id
      AND session.chat_id_encrypted IS NOT NULL
  );
