-- Ownership is enforced by 0012. Preserve any orphaned rows that could have
-- survived a partially managed pre-0012 deployment before re-validating it.
CREATE TABLE minutka_private.orphaned_ideas_0014
  (LIKE minutka_private.ideas INCLUDING ALL);
REVOKE ALL ON minutka_private.orphaned_ideas_0014 FROM minutka_runtime;

WITH orphaned AS (
  DELETE FROM minutka_private.ideas AS idea
  WHERE NOT EXISTS (
    SELECT 1
    FROM minutka_private.participants AS participant
    WHERE participant.employee_id = idea.user_id
  )
  RETURNING idea.*
)
INSERT INTO minutka_private.orphaned_ideas_0014 SELECT * FROM orphaned;
