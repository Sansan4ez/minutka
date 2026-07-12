CREATE INDEX IF NOT EXISTS insights_kind_recent
  ON minutka_private.insights(kind, created_at DESC);

ALTER TABLE minutka_audit.events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'invite_opened',
    'privacy_explanation_shown',
    'consent_accepted',
    'profile_updated',
    'onboarding_completed',
    'chat_received',
    'chat_response_generated',
    'work_boundary_applied',
    'insight_recorded',
    'insight_extraction_failed',
    'feedback_received',
    'agent_manual_load_failed',
    'employee_data_deleted'
  ));
