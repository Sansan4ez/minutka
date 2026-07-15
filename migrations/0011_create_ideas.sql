CREATE TABLE minutka_private.ideas (
  idea_id text PRIMARY KEY,
  user_id text NOT NULL,
  project text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN ('money', 'development', 'content', 'people', 'operations', 'knowledge', 'personal')),
  summary text NOT NULL CHECK (length(btrim(summary)) > 0),
  source jsonb,
  status text NOT NULL CHECK (status IN ('raw', 'discussed', 'planned', 'done', 'dropped')),
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL
);
CREATE INDEX ideas_owner_activity_idx ON minutka_private.ideas(user_id, last_activity_at, idea_id);
CREATE INDEX ideas_owner_status_idx ON minutka_private.ideas(user_id, status, created_at, idea_id);

-- 0009 grants default table privileges; retain the explicit grant so a database
-- upgraded from a non-default role setup remains runnable immediately.
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.ideas TO minutka_runtime;
