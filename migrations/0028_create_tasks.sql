ALTER TABLE minutka_private.ideas
  ADD CONSTRAINT ideas_id_owner_unique UNIQUE (idea_id, user_id);

CREATE TABLE minutka_private.tasks (
  task_id text PRIMARY KEY CHECK (length(btrim(task_id)) > 0),
  user_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  project text NOT NULL CHECK (length(btrim(project)) > 0),
  record_type text NOT NULL CHECK (record_type IN ('money', 'development', 'content', 'people', 'operations', 'knowledge', 'personal')),
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  due_date date,
  origin_idea_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  CONSTRAINT tasks_origin_idea_owner_fk FOREIGN KEY (origin_idea_id, user_id)
    REFERENCES minutka_private.ideas(idea_id, user_id),
  CONSTRAINT tasks_owner_origin_idea_unique UNIQUE (user_id, origin_idea_id)
);

CREATE INDEX tasks_owner_created_idx
  ON minutka_private.tasks(user_id, created_at, task_id);
CREATE INDEX tasks_owner_project_status_created_idx
  ON minutka_private.tasks(user_id, project, status, created_at, task_id);
CREATE INDEX tasks_owner_due_idx
  ON minutka_private.tasks(user_id, due_date, created_at, task_id)
  WHERE due_date IS NOT NULL;
CREATE INDEX tasks_owner_active_due_idx
  ON minutka_private.tasks(user_id, status, due_date, created_at, task_id)
  WHERE status IN ('open', 'in_progress');

-- The migrator owns schemas and tables. The runtime role receives only data
-- privileges and cannot create or alter schema objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.tasks TO minutka_runtime;
