CREATE TABLE minutka_private.usage (
  usage_id text NOT NULL CHECK (length(btrim(usage_id)) > 0),
  user_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  usage_month date NOT NULL CHECK (usage_month = date_trunc('month', usage_month)::date),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  estimated_cost_usd_micros bigint NOT NULL CHECK (estimated_cost_usd_micros >= 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

CREATE INDEX usage_owner_month_idx
  ON minutka_private.usage(user_id, usage_month, occurred_at, usage_id);

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
    'document_tool_used',
    'context_projection_degraded',
    'overflow_recovery',
    'thread_summary_updated',
    'thread_summary_failed',
    'task_mutation_proposed',
    'task_mutation_decided',
    'usage_soft_limit_exceeded',
    'employee_data_deleted'
  ));

GRANT SELECT, INSERT ON minutka_private.usage TO minutka_runtime;
