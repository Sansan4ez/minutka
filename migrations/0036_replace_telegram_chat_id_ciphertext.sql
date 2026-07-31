ALTER TABLE minutka_private.telegram_sessions
  DROP COLUMN chat_id_encrypted,
  ADD COLUMN chat_id_ciphertext bytea;

COMMENT ON COLUMN minutka_private.telegram_sessions.chat_id_ciphertext IS
  'AES-256-GCM encrypted Telegram chat id for proactive owner delivery; digest remains the lookup authority.';

-- pgcrypto ciphertext cannot be opened by the Node AES-GCM envelope. Existing
-- sessions deliberately become digest-only and recover through the relinking
-- path when their owner next sends a Telegram message.
DROP EXTENSION IF EXISTS pgcrypto;
