CREATE INDEX task_mutation_confirmations_pending_expiry_idx
  ON minutka_private.task_mutation_confirmations(expires_at, confirmation_id)
  WHERE completed_at IS NULL;

CREATE INDEX task_mutation_confirmations_completed_retention_idx
  ON minutka_private.task_mutation_confirmations(completed_at, confirmation_id)
  WHERE completed_at IS NOT NULL;

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
    'employee_data_deleted'
  ));
