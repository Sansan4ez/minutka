CREATE SCHEMA minutka_reporting;

CREATE TABLE minutka_private.activities (
  activity_id text PRIMARY KEY CHECK (length(btrim(activity_id)) > 0),
  employee_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  company_id text NOT NULL,
  group_id text NOT NULL,
  role_id text NOT NULL,
  kind text CHECK (kind IN ('task_category', 'routine_pattern', 'energy_stress_marker', 'automation_candidate')),
  value text,
  duration_bucket text CHECK (duration_bucket IN ('lt_15m', '15_30m', '30_60m', '1_2h', '2_4h', 'gt_4h')),
  system text CHECK (system IN ('bitrix24', 'one_c', 'spreadsheets', 'email', 'messengers', 'crm', 'task_tracker', 'paper_or_verbal', 'other')),
  recorded_at timestamptz NOT NULL,
  CHECK ((kind IS NULL) = (value IS NULL)),
  FOREIGN KEY (company_id, group_id)
    REFERENCES minutka_reference.training_groups(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, role_id)
    REFERENCES minutka_reference.roles(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE minutka_reporting.anonymized_activities (
  company_id text NOT NULL,
  group_id text NOT NULL,
  role_id text NOT NULL,
  kind text CHECK (kind IN ('task_category', 'routine_pattern', 'energy_stress_marker', 'automation_candidate')),
  value text,
  duration_bucket text CHECK (duration_bucket IN ('lt_15m', '15_30m', '30_60m', '1_2h', '2_4h', 'gt_4h')),
  system text CHECK (system IN ('bitrix24', 'one_c', 'spreadsheets', 'email', 'messengers', 'crm', 'task_tracker', 'paper_or_verbal', 'other')),
  activity_date date NOT NULL,
  CHECK ((kind IS NULL) = (value IS NULL)),
  FOREIGN KEY (company_id, group_id)
    REFERENCES minutka_reference.training_groups(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, role_id)
    REFERENCES minutka_reference.roles(company_id, id) ON DELETE RESTRICT
);
CREATE INDEX anonymized_activities_company_date
  ON minutka_reporting.anonymized_activities(company_id, activity_date);

GRANT USAGE ON SCHEMA minutka_reporting TO minutka_runtime;
GRANT SELECT, INSERT ON minutka_private.activities,
  minutka_reporting.anonymized_activities
TO minutka_runtime;
