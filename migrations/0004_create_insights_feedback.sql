CREATE TABLE minutka_private.insights (
  insight_id text PRIMARY KEY,
  employee_id text NOT NULL,
  thread_id text NOT NULL,
  source_message_id text NOT NULL REFERENCES minutka_private.messages(message_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('task_category', 'routine_pattern', 'energy_stress_marker', 'automation_candidate')),
  label text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (employee_id, thread_id) REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE
);
CREATE INDEX insights_employee_thread_recent ON minutka_private.insights(employee_id, thread_id, created_at DESC);

CREATE TABLE minutka_private.feedback (
  feedback_id text PRIMARY KEY,
  employee_id text NOT NULL,
  thread_id text NOT NULL,
  target_message_id text NOT NULL REFERENCES minutka_private.messages(message_id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('positive', 'neutral', 'negative')),
  source text NOT NULL CHECK (source IN ('cli', 'telegram', 'test')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (employee_id, thread_id, target_message_id),
  FOREIGN KEY (employee_id, thread_id) REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE
);
