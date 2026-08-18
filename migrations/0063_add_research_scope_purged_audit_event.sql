-- `privacy-v6`, the consent process and the research runbook promise a manual
-- operator purge of an exact company and of an exact company/group scope. The
-- runtime had only the subject-scoped `employee:data:delete`, so the promised
-- scopes had no typed command and no audit trail.
--
-- The purge itself needs no new table: every canonical and research row hangs
-- off `minutka_private.participants` through the composite tenant/subject keys
-- of `0062`, so deleting the participants of a scope cascades to messages,
-- activities, traces and evaluation cases. Only the audit record is new: one
-- identity-free row per purge that keeps scope, counts and outcome. Its
-- metadata allow-list lives in `src/application/audit-event-store.ts` and
-- excludes raw payload and subject lists.

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
    'employee_data_deleted'
  ));
