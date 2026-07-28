CREATE TABLE minutka_private.task_mutation_confirmations (
  confirmation_id text PRIMARY KEY CHECK (length(btrim(confirmation_id)) > 0),
  user_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  action_kind text NOT NULL CHECK (action_kind IN ('create', 'update', 'cancel')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome jsonb,
  CONSTRAINT task_mutation_confirmations_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT task_mutation_confirmations_completion_check CHECK (
    (completed_at IS NULL AND outcome IS NULL)
    OR (completed_at IS NOT NULL AND outcome IS NOT NULL AND completed_at >= created_at)
  )
);

CREATE INDEX task_mutation_confirmations_owner_pending_idx
  ON minutka_private.task_mutation_confirmations(user_id, expires_at)
  WHERE completed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.task_mutation_confirmations TO minutka_runtime;
