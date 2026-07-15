-- Rows created before ownership was enforced cannot be assigned safely.
-- Fail closed by removing orphans before adding the constraint.
DELETE FROM minutka_private.ideas AS idea
WHERE NOT EXISTS (
  SELECT 1
  FROM minutka_private.participants AS participant
  WHERE participant.employee_id = idea.user_id
);

ALTER TABLE minutka_private.ideas
  ADD CONSTRAINT ideas_owner_fk
  FOREIGN KEY (user_id)
  REFERENCES minutka_private.participants(employee_id)
  ON DELETE CASCADE;

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
    'chat_response_generated',
    'work_boundary_applied',
    'insight_recorded',
    'insight_extraction_failed',
    'feedback_received',
    'agent_manual_load_failed',
    'idea_captured',
    'employee_data_deleted'
  ));
