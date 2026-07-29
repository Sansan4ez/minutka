ALTER TABLE minutka_private.task_mutation_confirmations
  ADD COLUMN decision text CHECK (decision IN ('confirmed', 'rejected'));

UPDATE minutka_private.task_mutation_confirmations
SET decision = 'confirmed'
WHERE outcome IS NOT NULL;

ALTER TABLE minutka_private.task_mutation_confirmations
  DROP CONSTRAINT task_mutation_confirmations_completion_check,
  DROP CONSTRAINT task_mutation_confirmations_action_kind_check;

ALTER TABLE minutka_private.task_mutation_confirmations
  ADD CONSTRAINT task_mutation_confirmations_action_kind_check
    CHECK (action_kind IN ('create', 'update', 'complete', 'cancel', 'idea_to_task')),
  ADD CONSTRAINT task_mutation_confirmations_completion_check CHECK (
    (completed_at IS NULL AND decision IS NULL AND outcome IS NULL)
    OR (completed_at IS NOT NULL AND decision = 'confirmed' AND outcome IS NOT NULL AND completed_at >= created_at)
    OR (completed_at IS NOT NULL AND decision = 'rejected' AND outcome IS NULL AND completed_at >= created_at)
  );
