-- Cached input tokens are billed at a separate, lower rate, so the reported
-- count has to survive in durable storage to make the estimate re-checkable.
-- The column is nullable on purpose: NULL means "the provider reported no
-- cache breakdown for this call", which is not the same statement as 0
-- ("the provider reported a cache miss"). Rows written before this migration
-- are left NULL rather than backfilled with an invented cache hit or an
-- equally invented zero.
ALTER TABLE minutka_private.usage
  ADD COLUMN cached_input_tokens bigint
  CONSTRAINT usage_cached_input_tokens_check
  CHECK (cached_input_tokens IS NULL OR (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens));

COMMENT ON COLUMN minutka_private.usage.cached_input_tokens IS
  'Provider-reported prompt-cache hit for this call. NULL = not reported (unknown), 0 = reported cache miss.';
