ALTER TABLE minutka_private.process_schedules
  ADD COLUMN days_of_week smallint NOT NULL DEFAULT 127
    CONSTRAINT process_schedules_days_of_week_check CHECK (days_of_week BETWEEN 1 AND 127),
  ADD COLUMN kind text NOT NULL DEFAULT 'process'
    CONSTRAINT process_schedules_kind_check CHECK (kind IN ('process', 'reminder')),
  ADD COLUMN reminder_text text
    CONSTRAINT process_schedules_reminder_text_check CHECK (
      reminder_text IS NULL
      OR (length(btrim(reminder_text)) > 0 AND char_length(reminder_text) <= 512)
    ),
  ADD COLUMN one_shot boolean NOT NULL DEFAULT false;

ALTER TABLE minutka_private.process_schedules
  ALTER COLUMN process_id DROP NOT NULL,
  ADD CONSTRAINT process_schedules_action_check CHECK (
    (kind = 'process' AND process_id IS NOT NULL AND reminder_text IS NULL)
    OR (kind = 'reminder' AND reminder_text IS NOT NULL AND process_id IS NULL)
  );

ALTER TABLE minutka_private.schedule_fires
  ADD COLUMN days_of_week smallint NOT NULL DEFAULT 127
    CONSTRAINT schedule_fires_days_of_week_check CHECK (days_of_week BETWEEN 1 AND 127),
  ADD COLUMN kind text NOT NULL DEFAULT 'process'
    CONSTRAINT schedule_fires_kind_check CHECK (kind IN ('process', 'reminder')),
  ADD COLUMN reminder_text text
    CONSTRAINT schedule_fires_reminder_text_check CHECK (
      reminder_text IS NULL
      OR (length(btrim(reminder_text)) > 0 AND char_length(reminder_text) <= 512)
    ),
  ADD COLUMN one_shot boolean NOT NULL DEFAULT false;

ALTER TABLE minutka_private.schedule_fires
  ALTER COLUMN process_id DROP NOT NULL,
  ADD CONSTRAINT schedule_fires_action_check CHECK (
    (kind = 'process' AND process_id IS NOT NULL AND reminder_text IS NULL)
    OR (kind = 'reminder' AND reminder_text IS NOT NULL AND process_id IS NULL)
  );

COMMENT ON COLUMN minutka_private.process_schedules.days_of_week IS
  'Seven-bit ISO weekday mask: bit 0 Monday, bit 6 Sunday; 127 means every day.';
COMMENT ON COLUMN minutka_private.process_schedules.kind IS
  'Scheduled action discriminator: process or owner-authored reminder.';
COMMENT ON COLUMN minutka_private.process_schedules.one_shot IS
  'When true, the schedule is disabled after its first successful fire.';
