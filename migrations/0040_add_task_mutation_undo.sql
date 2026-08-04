ALTER TABLE minutka_private.task_mutation_confirmations
  ADD COLUMN undo_context jsonb,
  ADD COLUMN before_task jsonb,
  ADD COLUMN undo_expires_at timestamptz,
  ADD COLUMN undone_at timestamptz;

ALTER TABLE minutka_private.task_mutation_confirmations
  ADD CONSTRAINT task_mutation_confirmations_undo_check CHECK (
    (undo_expires_at IS NULL AND undone_at IS NULL)
    OR (
      decision = 'confirmed'
      AND completed_at IS NOT NULL
      AND undo_expires_at > completed_at
      AND (undone_at IS NULL OR (undone_at >= completed_at AND undone_at <= undo_expires_at))
    )
  );

CREATE INDEX task_mutation_confirmations_owner_undo_idx
  ON minutka_private.task_mutation_confirmations(user_id, completed_at DESC, confirmation_id DESC)
  WHERE decision = 'confirmed' AND action_kind IN ('create', 'update', 'complete', 'idea_to_task');
