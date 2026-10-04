-- Canonical metadata lives with its message, so writes and cascading purge are atomic.
ALTER TABLE minutka_private.messages ADD COLUMN metadata jsonb;
ALTER TABLE minutka_private.messages ADD CONSTRAINT messages_metadata_version
  CHECK (metadata IS NULL OR (jsonb_typeof(metadata) = 'object' AND metadata->>'version' = '1'));
