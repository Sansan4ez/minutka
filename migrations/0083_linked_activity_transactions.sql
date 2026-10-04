-- Durable reservations intentionally survive unknown outcomes: no blind retry.
CREATE TABLE minutka_private.linked_activity_transactions (
  employee_id text NOT NULL,
  company_id text NOT NULL,
  group_id text NOT NULL,
  subject_key uuid NOT NULL REFERENCES minutka_private.participants(subject_key) ON DELETE CASCADE,
  thread_id text NOT NULL,
  source_message_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  outcome jsonb,
  PRIMARY KEY (employee_id, company_id, group_id, subject_key, thread_id, source_message_id, ordinal),
  FOREIGN KEY (employee_id, thread_id) REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.linked_activity_transactions TO minutka_runtime;
