-- `collectActivity` runs inside the agent tool loop, and the turn's message row
-- is written only after that loop ends, so an insert-time foreign key made the
-- first real activity collection of every turn fail with 23503.
--
-- The evidence link keeps its meaning without the insert-order coupling: it is
-- resolved against `minutka_private.messages` by research readers, exactly like
-- `minutka_research.traces.message_id` already is. A turn that fails before the
-- conversation append leaves the collected activity in place with a link that
-- resolves to nothing, which is the intended durable-corpus behaviour. Owner and
-- subject of the link are validated at the typed write boundary instead.
ALTER TABLE minutka_private.activities
  DROP CONSTRAINT activities_source_message_fk;
