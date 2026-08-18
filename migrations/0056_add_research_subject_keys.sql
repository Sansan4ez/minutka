ALTER TABLE minutka_private.participants
  ADD COLUMN subject_key uuid;

UPDATE minutka_private.participants
SET subject_key = gen_random_uuid()
WHERE subject_key IS NULL;

ALTER TABLE minutka_private.participants
  ALTER COLUMN subject_key SET NOT NULL,
  ADD CONSTRAINT participants_group_subject_unique UNIQUE (group_id, subject_key),
  ADD CONSTRAINT participants_subject_unique UNIQUE (subject_key);

ALTER TABLE minutka_private.messages
  ADD COLUMN subject_key uuid;

UPDATE minutka_private.messages AS message
SET subject_key = participant.subject_key
FROM minutka_private.participants AS participant
WHERE participant.employee_id = message.employee_id;

ALTER TABLE minutka_private.messages
  ADD CONSTRAINT messages_subject_fk
    FOREIGN KEY (subject_key)
    REFERENCES minutka_private.participants(subject_key) ON DELETE CASCADE;
CREATE INDEX messages_subject_recent
  ON minutka_private.messages(subject_key, created_at DESC, message_id DESC);

ALTER TABLE minutka_private.activities
  ADD COLUMN subject_key uuid;

UPDATE minutka_private.activities AS activity
SET subject_key = participant.subject_key
FROM minutka_private.participants AS participant
WHERE participant.employee_id = activity.employee_id;

ALTER TABLE minutka_private.activities
  ALTER COLUMN subject_key SET NOT NULL,
  ADD CONSTRAINT activities_subject_fk
    FOREIGN KEY (subject_key)
    REFERENCES minutka_private.participants(subject_key) ON DELETE CASCADE;
CREATE INDEX activities_subject_recorded
  ON minutka_private.activities(subject_key, recorded_at DESC, activity_id);
