DROP INDEX minutka_private.task_mutation_confirmations_owner_undo_idx;

CREATE INDEX task_mutation_confirmations_owner_undo_idx
  ON minutka_private.task_mutation_confirmations(user_id, completed_at DESC, confirmation_id DESC)
  WHERE decision = 'confirmed' AND undone_at IS NULL
    AND action_kind IN ('create', 'update', 'complete', 'idea_to_task');
