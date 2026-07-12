CREATE TABLE minutka_private.participants (
  employee_id text PRIMARY KEY,
  invite_code_digest bytea UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('invite_issued', 'invite_opened', 'consent_accepted', 'profile_completed')),
  privacy_explanation_shown_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE minutka_private.consents (
  employee_id text PRIMARY KEY REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  explanation_shown_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('cli', 'telegram', 'test'))
);

CREATE TABLE minutka_private.profiles (
  employee_id text PRIMARY KEY REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  role text NOT NULL,
  typical_tasks jsonb NOT NULL,
  persona text NOT NULL CHECK (persona IN ('support', 'efficiency')),
  ai_level text NOT NULL CHECK (ai_level IN ('beginner', 'intermediate', 'advanced')),
  response_length text NOT NULL CHECK (response_length IN ('short', 'balanced', 'detailed')),
  preferred_checkins_per_day smallint CHECK (preferred_checkins_per_day BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
