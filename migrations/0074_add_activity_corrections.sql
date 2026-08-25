ALTER TABLE minutka_private.activities
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  ADD COLUMN superseded_by_activity_id text,
  ADD COLUMN last_correction_message_id text,
  ADD COLUMN updated_at timestamptz;

UPDATE minutka_private.activities SET updated_at = recorded_at;

ALTER TABLE minutka_private.activities
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT activities_superseded_by_fk
    FOREIGN KEY (superseded_by_activity_id)
    REFERENCES minutka_private.activities(activity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT activities_status_link_check CHECK (
    (status = 'active' AND superseded_by_activity_id IS NULL)
    OR (status = 'superseded' AND superseded_by_activity_id IS NOT NULL)
  );

CREATE TABLE minutka_private.activity_revisions (
  activity_id text NOT NULL REFERENCES minutka_private.activities(activity_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  operation text NOT NULL CHECK (operation IN ('created', 'corrected', 'superseded')),
  source_message_id text,
  task_category text CHECK (task_category IN ('planning', 'reporting', 'meetings', 'coordination', 'communication', 'admin', 'focus_work', 'unknown')),
  routine_pattern text CHECK (routine_pattern IN ('meeting_overload', 'context_switching', 'manual_reporting', 'coordination_overhead', 'waiting_for_input', 'unclear_priority', 'other')),
  automation_candidate text CHECK (automation_candidate IN ('report_generation', 'meeting_reduction', 'async_status_update', 'task_routing', 'template_or_checklist', 'data_entry_reduction', 'other')),
  energy_stress_marker text CHECK (energy_stress_marker IN ('overload', 'fatigue', 'frustration', 'focus_loss', 'blocked_progress', 'neutral')),
  duration_bucket text CHECK (duration_bucket IN ('lt_15m', '15_30m', '30_60m', '1_2h', '2_4h', 'gt_4h')),
  system text CHECK (system IN ('bitrix24', 'one_c', 'spreadsheets', 'email', 'messengers', 'crm', 'task_tracker', 'paper_or_verbal', 'documents', 'video_conferencing', 'erp', 'other')),
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  superseded_by_activity_id text,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (activity_id, revision)
);

INSERT INTO minutka_private.activity_revisions
  (activity_id, revision, operation, source_message_id, task_category, routine_pattern,
   automation_candidate, energy_stress_marker, duration_bucket, system, status,
   superseded_by_activity_id, changed_at)
SELECT activity_id, 1, 'created', source_message_id, task_category, routine_pattern,
       automation_candidate, energy_stress_marker, duration_bucket, system, 'active', NULL, recorded_at
FROM minutka_private.activities;

CREATE INDEX activity_revisions_changed
  ON minutka_private.activity_revisions(activity_id, changed_at, revision);

GRANT UPDATE ON minutka_private.activities TO minutka_runtime;
GRANT SELECT, INSERT ON minutka_private.activity_revisions TO minutka_runtime;
