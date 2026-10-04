-- Disposable projection; canonical message metadata remains the replay source.
CREATE TABLE minutka_private.retrospective_episodes (
  employee_id text NOT NULL,
  thread_id text NOT NULL,
  company_id text NOT NULL,
  group_id text NOT NULL,
  subject_key uuid NOT NULL REFERENCES minutka_private.participants(subject_key) ON DELETE CASCADE,
  episode_id text NOT NULL,
  pending boolean NOT NULL,
  projection jsonb NOT NULL,
  PRIMARY KEY (employee_id, thread_id, episode_id),
  FOREIGN KEY (employee_id, thread_id) REFERENCES minutka_private.threads(employee_id, thread_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX retrospective_one_pending ON minutka_private.retrospective_episodes(employee_id, thread_id) WHERE pending;
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.retrospective_episodes TO minutka_runtime;
