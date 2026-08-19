-- Optional employee-only context collected after onboarding through ordinary
-- conversation. Existing profiles remain valid and company/reporting tables are
-- intentionally unchanged.
CREATE FUNCTION minutka_private.valid_typical_tasks(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN 1 AND 7
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS item
      WHERE jsonb_typeof(item) <> 'string'
        OR char_length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 160
    );
$$;

ALTER TABLE minutka_private.profiles
  ADD COLUMN program_goal text,
  ADD CONSTRAINT profiles_typical_tasks_bounded_check CHECK (
    typical_tasks IS NULL OR minutka_private.valid_typical_tasks(typical_tasks)
  ),
  ADD CONSTRAINT profiles_program_goal_check CHECK (
    program_goal IS NULL OR char_length(btrim(program_goal)) BETWEEN 1 AND 500
  );
