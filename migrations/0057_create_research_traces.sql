CREATE SCHEMA minutka_research;

CREATE TABLE minutka_research.traces (
  trace_id text PRIMARY KEY CHECK (length(btrim(trace_id)) > 0),
  schema_version text NOT NULL CHECK (length(btrim(schema_version)) > 0),
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  message_id text NOT NULL CHECK (length(btrim(message_id)) > 0),
  company_id text NOT NULL,
  group_id text NOT NULL,
  subject_key uuid NOT NULL REFERENCES minutka_private.participants(subject_key) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  prompt_version text NOT NULL CHECK (length(btrim(prompt_version)) > 0),
  process_version text NOT NULL CHECK (length(btrim(process_version)) > 0),
  taxonomy_version text NOT NULL CHECK (length(btrim(taxonomy_version)) > 0),
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  sampling_rate numeric NOT NULL CHECK (sampling_rate = 1),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (company_id, group_id)
    REFERENCES minutka_reference.training_groups(company_id, id) ON DELETE RESTRICT,
  CHECK (payload->>'schemaVersion' = schema_version),
  CHECK (payload->>'traceId' = trace_id),
  CHECK (payload->>'requestId' = request_id),
  CHECK (payload->>'messageId' = message_id),
  CHECK (payload->>'companyId' = company_id),
  CHECK (payload->>'groupId' = group_id),
  CHECK (payload->>'subjectKey' = subject_key::text),
  CHECK (payload->>'status' = status)
);
CREATE INDEX research_traces_tenant_started
  ON minutka_research.traces(company_id, group_id, started_at, trace_id);
CREATE INDEX research_traces_subject_started
  ON minutka_research.traces(subject_key, started_at, trace_id);
CREATE INDEX research_traces_request
  ON minutka_research.traces(request_id);
CREATE INDEX research_traces_message
  ON minutka_research.traces(message_id);

GRANT USAGE ON SCHEMA minutka_research TO minutka_runtime;
GRANT SELECT, INSERT, DELETE ON minutka_research.traces TO minutka_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE minutka_migrator IN SCHEMA minutka_research
  GRANT SELECT, INSERT, DELETE ON TABLES TO minutka_runtime;

ALTER TABLE minutka_audit.events
  DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE minutka_audit.events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'invite_opened',
    'privacy_explanation_shown',
    'consent_accepted',
    'profile_updated',
    'onboarding_completed',
    'chat_received',
    'request_integrity_denied',
    'chat_response_generated',
    'work_boundary_applied',
    'insight_recorded',
    'insight_extraction_failed',
    'feedback_received',
    'agent_manual_load_failed',
    'idea_captured',
    'idea_appended',
    'idea_deletion_proposed',
    'idea_deletion_decided',
    'idea_deletion_undone',
    'document_tool_used',
    'context_document_mutated',
    'context_projection_degraded',
    'overflow_recovery',
    'thread_summary_updated',
    'thread_summary_failed',
    'task_mutation_proposed',
    'task_mutation_decided',
    'task_mutation_undone',
    'usage_soft_limit_exceeded',
    'trace_missing',
    'employee_data_deleted'
  ));
