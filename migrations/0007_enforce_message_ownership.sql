ALTER TABLE minutka_private.messages
  ADD CONSTRAINT messages_message_employee_thread_unique
  UNIQUE (message_id, employee_id, thread_id);

ALTER TABLE minutka_private.insights
  DROP CONSTRAINT insights_source_message_id_fkey,
  ADD CONSTRAINT insights_source_message_owner_fkey
  FOREIGN KEY (source_message_id, employee_id, thread_id)
  REFERENCES minutka_private.messages(message_id, employee_id, thread_id)
  ON DELETE CASCADE;

ALTER TABLE minutka_private.feedback
  DROP CONSTRAINT feedback_target_message_id_fkey,
  ADD CONSTRAINT feedback_target_message_owner_fkey
  FOREIGN KEY (target_message_id, employee_id, thread_id)
  REFERENCES minutka_private.messages(message_id, employee_id, thread_id)
  ON DELETE CASCADE;
