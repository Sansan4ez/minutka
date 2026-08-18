-- Canonical research rows carried `company_id`, `group_id` and `subject_key` as
-- three independent foreign keys, so the database accepted a subject of company A
-- next to a valid group of company B: only the typed write boundary kept the
-- tuple honest, and a malformed write could reach export and the client report.
--
-- The composite keys below make the whole tuple the reference. A subject belongs
-- to exactly one company and group; an activity or message belongs to its own
-- subject; an evaluation case belongs to the tuple of its trace, not just to a
-- global trace id. Every single-column key dropped here is strictly subsumed by
-- the composite key that replaces it, cascade behaviour included.
--
-- Referencing-side lookups stay indexed: the RI delete probes each table by an
-- equality on `subject_key` (`messages_subject_recent`, `activities_subject_recorded`,
-- `research_traces_subject_started`) or on `trace_id` (`evaluation_cases_trace`).

ALTER TABLE minutka_private.participants
  ADD CONSTRAINT participants_employee_subject_unique UNIQUE (employee_id, subject_key),
  ADD CONSTRAINT participants_tenant_subject_unique UNIQUE (company_id, group_id, subject_key);

ALTER TABLE minutka_private.messages
  DROP CONSTRAINT messages_subject_fk,
  ADD CONSTRAINT messages_owner_subject_fk
    FOREIGN KEY (employee_id, subject_key)
    REFERENCES minutka_private.participants(employee_id, subject_key) ON DELETE CASCADE;

ALTER TABLE minutka_private.activities
  DROP CONSTRAINT activities_employee_id_fkey,
  DROP CONSTRAINT activities_subject_fk,
  ADD CONSTRAINT activities_owner_subject_fk
    FOREIGN KEY (employee_id, subject_key)
    REFERENCES minutka_private.participants(employee_id, subject_key) ON DELETE CASCADE,
  ADD CONSTRAINT activities_tenant_subject_fk
    FOREIGN KEY (company_id, group_id, subject_key)
    REFERENCES minutka_private.participants(company_id, group_id, subject_key) ON DELETE CASCADE;

ALTER TABLE minutka_research.traces
  DROP CONSTRAINT traces_subject_key_fkey,
  ADD CONSTRAINT traces_tenant_subject_fk
    FOREIGN KEY (company_id, group_id, subject_key)
    REFERENCES minutka_private.participants(company_id, group_id, subject_key) ON DELETE CASCADE,
  ADD CONSTRAINT traces_tenant_subject_unique UNIQUE (trace_id, company_id, group_id, subject_key);

ALTER TABLE minutka_research.evaluation_cases
  DROP CONSTRAINT evaluation_cases_trace_id_fkey,
  DROP CONSTRAINT evaluation_cases_subject_key_fkey,
  ADD CONSTRAINT evaluation_cases_trace_tenant_subject_fk
    FOREIGN KEY (trace_id, company_id, group_id, subject_key)
    REFERENCES minutka_research.traces(trace_id, company_id, group_id, subject_key) ON DELETE CASCADE;
