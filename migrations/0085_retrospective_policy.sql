CREATE TABLE minutka_private.retrospective_policies (
  company_id text NOT NULL,
  group_id text NOT NULL,
  policy jsonb NOT NULL,
  PRIMARY KEY (company_id, group_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.retrospective_policies TO minutka_runtime;
