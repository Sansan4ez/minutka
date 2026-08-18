-- Legacy assistant schedules remain durable for audit and rollback, but only
-- Minutka's morning and evening employee messages may stay active.
UPDATE minutka_private.process_schedules
SET enabled = false,
    updated_at = now()
WHERE enabled
  AND (
    kind <> 'process'
    OR process_id NOT IN ('morning_activity_collection', 'evening_reflection')
  );
