CREATE TABLE minutka_private.onboarding_drafts (
  employee_id text PRIMARY KEY REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  role text,
  typical_tasks jsonb,
  persona text CHECK (persona IN ('support', 'efficiency')),
  ai_level text CHECK (ai_level IN ('beginner', 'intermediate', 'advanced')),
  status text NOT NULL CHECK (status IN ('collecting', 'awaiting_confirmation')),
  pending_field text CHECK (pending_field IN ('role', 'typicalTasks', 'persona', 'aiLevel')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX onboarding_drafts_expires_at_idx ON minutka_private.onboarding_drafts(expires_at);
