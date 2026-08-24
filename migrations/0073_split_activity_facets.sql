ALTER TABLE minutka_private.activities
  ADD COLUMN routine_pattern text,
  ADD COLUMN automation_candidate text,
  ADD COLUMN energy_stress_marker text;

ALTER TABLE minutka_private.activities
  ADD CONSTRAINT activities_routine_pattern_check CHECK (
    routine_pattern IN (
      'meeting_overload', 'context_switching', 'manual_reporting', 'coordination_overhead',
      'waiting_for_input', 'unclear_priority', 'other'
    )
  ),
  ADD CONSTRAINT activities_automation_candidate_check CHECK (
    automation_candidate IN (
      'report_generation', 'meeting_reduction', 'async_status_update', 'task_routing',
      'template_or_checklist', 'data_entry_reduction', 'other'
    )
  ),
  ADD CONSTRAINT activities_energy_stress_marker_check CHECK (
    energy_stress_marker IN (
      'overload', 'fatigue', 'frustration', 'focus_loss', 'blocked_progress', 'neutral'
    )
  );

-- A legacy row contains exactly one classified facet. Copy only that known
-- value; absent historical facets remain NULL rather than being inferred.
UPDATE minutka_private.activities
SET routine_pattern = CASE WHEN obstacle_kind = 'routine_pattern' THEN obstacle_value END,
    automation_candidate = CASE WHEN obstacle_kind = 'automation_candidate' THEN obstacle_value END,
    energy_stress_marker = CASE WHEN obstacle_kind = 'energy_stress_marker' THEN obstacle_value END;

ALTER TABLE minutka_private.activities
  DROP CONSTRAINT activities_obstacle_value_check,
  DROP CONSTRAINT activities_obstacle_kind_check,
  DROP CONSTRAINT activities_check,
  DROP COLUMN obstacle_kind,
  DROP COLUMN obstacle_value;
