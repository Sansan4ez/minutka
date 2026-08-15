CREATE SCHEMA minutka_reference;

CREATE TABLE minutka_reference.companies (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0)
);

CREATE TABLE minutka_reference.training_groups (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  company_id text NOT NULL REFERENCES minutka_reference.companies(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  period daterange NOT NULL CHECK (NOT isempty(period)),
  CONSTRAINT training_groups_company_id_id_unique UNIQUE (company_id, id)
);

CREATE TABLE minutka_reference.roles (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  company_id text NOT NULL REFERENCES minutka_reference.companies(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  CONSTRAINT roles_company_id_name_unique UNIQUE (company_id, name),
  CONSTRAINT roles_company_id_id_unique UNIQUE (company_id, id)
);

GRANT USAGE ON SCHEMA minutka_reference TO minutka_runtime;
GRANT SELECT ON minutka_reference.companies,
  minutka_reference.training_groups,
  minutka_reference.roles
TO minutka_runtime;
