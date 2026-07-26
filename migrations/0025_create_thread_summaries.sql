CREATE TABLE minutka_private.thread_summaries (
  employee_id text NOT NULL,
  thread_id text NOT NULL,
  summary_text text NOT NULL,
  watermark_from_message_id text NOT NULL,
  watermark_through_message_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (employee_id, thread_id),
  CONSTRAINT thread_summaries_thread_fk FOREIGN KEY (employee_id, thread_id)
    REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE,
  CONSTRAINT thread_summaries_from_message_fk FOREIGN KEY (watermark_from_message_id, employee_id, thread_id)
    REFERENCES minutka_private.messages(message_id, employee_id, thread_id),
  CONSTRAINT thread_summaries_through_message_fk FOREIGN KEY (watermark_through_message_id, employee_id, thread_id)
    REFERENCES minutka_private.messages(message_id, employee_id, thread_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.thread_summaries TO minutka_runtime;
