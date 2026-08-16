ALTER TABLE minutka_private.activities
  ADD CONSTRAINT activities_obstacle_value_check CHECK (
    obstacle_value IN (
      'meeting_overload', 'context_switching', 'manual_reporting', 'coordination_overhead',
      'waiting_for_input', 'unclear_priority', 'other',
      'overload', 'fatigue', 'frustration', 'focus_loss', 'blocked_progress', 'neutral',
      'report_generation', 'meeting_reduction', 'async_status_update', 'task_routing',
      'template_or_checklist', 'data_entry_reduction'
    )
  );

ALTER TABLE minutka_reporting.anonymized_activities
  ADD CONSTRAINT anonymized_activities_obstacle_value_check CHECK (
    obstacle_value IN (
      'meeting_overload', 'context_switching', 'manual_reporting', 'coordination_overhead',
      'waiting_for_input', 'unclear_priority', 'other',
      'overload', 'fatigue', 'frustration', 'focus_loss', 'blocked_progress', 'neutral',
      'report_generation', 'meeting_reduction', 'async_status_update', 'task_routing',
      'template_or_checklist', 'data_entry_reduction'
    )
  );
