ALTER TABLE minutka_private.activities
  ADD COLUMN source_message_id text,
  ADD COLUMN activity_date date;

UPDATE minutka_private.activities AS activity
SET activity_date = (activity.recorded_at AT TIME ZONE profile.timezone)::date
FROM minutka_private.profiles AS profile
WHERE profile.employee_id = activity.employee_id
  AND activity.activity_date IS NULL;

UPDATE minutka_private.activities
SET activity_date = recorded_at::date
WHERE activity_date IS NULL;

ALTER TABLE minutka_private.activities
  ALTER COLUMN activity_date SET NOT NULL,
  ADD CONSTRAINT activities_source_message_fk
    FOREIGN KEY (source_message_id)
    REFERENCES minutka_private.messages(message_id) ON DELETE SET NULL;

CREATE INDEX activities_source_message
  ON minutka_private.activities(source_message_id)
  WHERE source_message_id IS NOT NULL;

DROP TABLE minutka_reporting.anonymized_activities;
DROP SCHEMA minutka_reporting;
