CREATE TABLE minutka_private.threads (
  employee_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (employee_id, thread_id)
);

CREATE TABLE minutka_private.messages (
  message_id text PRIMARY KEY,
  employee_id text NOT NULL,
  thread_id text NOT NULL,
  user_text text NOT NULL,
  agent_response text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (employee_id, thread_id) REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE
);
CREATE INDEX messages_employee_thread_recent ON minutka_private.messages(employee_id, thread_id, created_at DESC, message_id DESC);
