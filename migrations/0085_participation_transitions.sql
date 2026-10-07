-- Private operator receipt; preserves lineage without changing historical scopes.
CREATE TABLE minutka_private.participation_transitions (
  source_employee_id text PRIMARY KEY REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  target_employee_id text UNIQUE NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_employee_id <> target_employee_id)
);
GRANT SELECT, INSERT ON minutka_private.participation_transitions TO minutka_runtime;
