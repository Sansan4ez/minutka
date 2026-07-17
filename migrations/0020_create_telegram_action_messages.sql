CREATE TABLE minutka_private.telegram_action_messages (
  chat_id_digest bytea NOT NULL REFERENCES minutka_private.telegram_sessions(chat_id_digest) ON DELETE CASCADE,
  message_id bigint NOT NULL,
  employee_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id_digest, message_id)
);
