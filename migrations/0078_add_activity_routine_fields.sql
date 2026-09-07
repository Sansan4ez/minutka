ALTER TABLE minutka_private.activities
  ADD COLUMN routine_id text,
  ADD COLUMN routine_label text,
  ADD COLUMN recurrence text;

ALTER TABLE minutka_private.activities
  ADD CONSTRAINT activities_recurrence_check CHECK (
    recurrence IN ('daily', 'several_per_week', 'weekly', 'monthly', 'one_off')
  );

ALTER TABLE minutka_private.activity_revisions
  ADD COLUMN routine_id text,
  ADD COLUMN routine_label text,
  ADD COLUMN recurrence text;

ALTER TABLE minutka_private.activity_revisions
  ADD CONSTRAINT activity_revisions_recurrence_check CHECK (
    recurrence IN ('daily', 'several_per_week', 'weekly', 'monthly', 'one_off')
  );

