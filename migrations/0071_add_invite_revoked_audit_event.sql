-- Allow the invite_revoked audit event type for tracking participant deletion
-- when the participant is still in invite_issued status (unused invite).

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
    'research_corpus_exported',
    'research_scope_purged',
    'invite_revoked',
    'employee_data_deleted'
  ));
