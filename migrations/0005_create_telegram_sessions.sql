CREATE TABLE minutka_private.telegram_sessions (
  chat_id_digest bytea PRIMARY KEY,
  user_id_digest bytea,
  employee_id text UNIQUE NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  consent_accepted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
