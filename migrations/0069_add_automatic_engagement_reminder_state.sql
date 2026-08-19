-- The soft participation reminder is sent automatically by the daily sweep, so
-- the per-participant limits it enforces (one reminder per rolling 24 hours and
-- a bounded number of automatic reminders before the live tier) need durable
-- state that survives a restart.
ALTER TABLE minutka_private.participants
  ADD COLUMN engagement_reminders_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN last_engagement_reminder_at timestamptz;
