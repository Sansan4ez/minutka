-- Keep every employee's existing morning configuration while replacing the
-- retired collection process with morning planning. The schedule id stays
-- stable so owner-scoped links and the fire ledger remain intact.
UPDATE minutka_private.process_schedules
SET process_id = 'morning_planning',
    updated_at = now()
WHERE kind = 'process'
  AND process_id = 'morning_activity_collection';

-- Historical fires describe what actually ran and are intentionally unchanged.
