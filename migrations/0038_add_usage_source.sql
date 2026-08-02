-- One owner turn produces several LLM calls (chat, onboarding extraction,
-- thread summarization, request-integrity guard). A usage row is therefore
-- "one LLM call of one turn", not "one turn", and the deduplication key has to
-- carry the source: with the previous (request_id, user_id) key the auxiliary
-- calls of the same request were silently dropped by ON CONFLICT DO NOTHING.
ALTER TABLE minutka_private.usage
  ADD COLUMN source text NOT NULL DEFAULT 'chat'
  CONSTRAINT usage_source_check CHECK (source IN ('chat', 'onboarding', 'summarization', 'guard'));

-- Every row accumulated before this migration came from the main chat runner,
-- so the column default is the backfill. Drop it afterwards: from now on the
-- writer always states the source explicitly and never defaults silently.
ALTER TABLE minutka_private.usage ALTER COLUMN source DROP DEFAULT;

ALTER TABLE minutka_private.usage DROP CONSTRAINT usage_pkey;
ALTER TABLE minutka_private.usage ADD CONSTRAINT usage_pkey PRIMARY KEY (request_id, user_id, source);

DROP INDEX minutka_private.usage_owner_month_idx;
CREATE INDEX usage_owner_month_source_idx
  ON minutka_private.usage(user_id, usage_month, source, occurred_at, usage_id);

COMMENT ON COLUMN minutka_private.usage.source IS
  'Which LLM call of the owner turn produced this row. Part of the deduplication key.';
