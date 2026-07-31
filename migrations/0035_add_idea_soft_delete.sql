ALTER TABLE minutka_private.ideas
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN undo_expires_at timestamptz,
  ADD CONSTRAINT ideas_deletion_state_check CHECK (
    (deleted_at IS NULL AND undo_expires_at IS NULL)
    OR (deleted_at IS NOT NULL AND undo_expires_at IS NOT NULL AND undo_expires_at > deleted_at)
  );

CREATE INDEX ideas_owner_active_activity_idx
  ON minutka_private.ideas(user_id, last_activity_at DESC, idea_id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX ideas_owner_deleted_activity_idx
  ON minutka_private.ideas(user_id, last_activity_at DESC, idea_id DESC)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE minutka_private.idea_deletion_confirmations (
  confirmation_id text PRIMARY KEY CHECK (length(btrim(confirmation_id)) > 0),
  user_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  decision text CHECK (decision IN ('confirmed', 'rejected')),
  outcome jsonb,
  CONSTRAINT idea_deletion_confirmations_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT idea_deletion_confirmations_completion_check CHECK (
    (completed_at IS NULL AND decision IS NULL AND outcome IS NULL)
    OR (completed_at IS NOT NULL AND decision = 'confirmed' AND outcome IS NOT NULL AND completed_at >= created_at)
    OR (completed_at IS NOT NULL AND decision = 'rejected' AND outcome IS NULL AND completed_at >= created_at)
  )
);

CREATE INDEX idea_deletion_confirmations_owner_pending_idx
  ON minutka_private.idea_deletion_confirmations(user_id, expires_at, confirmation_id)
  WHERE completed_at IS NULL;

CREATE INDEX idea_deletion_confirmations_completed_retention_idx
  ON minutka_private.idea_deletion_confirmations(completed_at, confirmation_id)
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
    'idea_deletion_proposed',
    'idea_deletion_decided',
    'idea_deletion_undone',
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

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.idea_deletion_confirmations TO minutka_runtime;
