CREATE TABLE minutka_private.process_schedules (
  schedule_id text PRIMARY KEY CHECK (length(btrim(schedule_id)) > 0),
  user_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  process_id text NOT NULL CHECK (length(btrim(process_id)) > 0),
  time_of_day text NOT NULL CHECK (time_of_day ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text NOT NULL CHECK (length(btrim(timezone)) > 0),
  enabled boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT process_schedules_id_owner_unique UNIQUE (schedule_id, user_id)
);

CREATE TABLE minutka_private.schedule_fires (
  schedule_id text NOT NULL,
  user_id text NOT NULL,
  process_id text NOT NULL CHECK (length(btrim(process_id)) > 0),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  PRIMARY KEY (schedule_id, scheduled_for),
  CONSTRAINT schedule_fires_schedule_owner_fk FOREIGN KEY (schedule_id, user_id)
    REFERENCES minutka_private.process_schedules(schedule_id, user_id) ON DELETE CASCADE,
  CONSTRAINT schedule_fires_completion_check CHECK (
    (status = 'pending' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND length(btrim(error_code)) > 0)
  )
);

CREATE INDEX process_schedules_due_idx
  ON minutka_private.process_schedules(next_fire_at, schedule_id)
  WHERE enabled;
CREATE INDEX schedule_fires_pending_idx
  ON minutka_private.schedule_fires(created_at, schedule_id, scheduled_for)
  WHERE status = 'pending';
CREATE INDEX schedule_fires_owner_created_idx
  ON minutka_private.schedule_fires(user_id, created_at, schedule_id, scheduled_for);

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.process_schedules, minutka_private.schedule_fires TO minutka_runtime;
