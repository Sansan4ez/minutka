CREATE TABLE minutka_audit.events (
  event_id text PRIMARY KEY,
  request_id text NOT NULL,
  event_type text NOT NULL,
  employee_id text,
  thread_id text,
  message_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX audit_request_recent ON minutka_audit.events(request_id, occurred_at);
CREATE INDEX audit_employee_thread_recent ON minutka_audit.events(employee_id, thread_id, occurred_at DESC);
