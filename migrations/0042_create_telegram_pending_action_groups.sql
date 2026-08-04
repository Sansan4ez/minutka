CREATE TABLE minutka_private.telegram_pending_action_groups (
  group_id text PRIMARY KEY CHECK (group_id ~ '^[0-9a-f]{24}$'),
  owner_id text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 5),
  state text NOT NULL CHECK (state IN ('preparing', 'delivered', 'completed', 'cancelled')),
  message_id bigint CHECK (message_id > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT telegram_pending_action_groups_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT telegram_pending_action_groups_delivery_check CHECK (
    (state = 'preparing' AND message_id IS NULL)
    OR (state IN ('delivered', 'completed') AND message_id IS NOT NULL)
    OR state = 'cancelled'
  )
);

CREATE INDEX telegram_pending_action_groups_owner_latest_idx
  ON minutka_private.telegram_pending_action_groups(owner_id, created_at DESC, group_id DESC)
  WHERE state = 'delivered';

CREATE INDEX telegram_pending_action_groups_expiry_idx
  ON minutka_private.telegram_pending_action_groups(expires_at, group_id);

COMMENT ON COLUMN minutka_private.telegram_pending_action_groups.items IS
  'Safe Telegram transport projections only: confirmation receipts/previews, immutable ordinals, and item states. No canonical proposal payloads, document bodies, chat ids, or secrets.';

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.telegram_pending_action_groups TO minutka_runtime;
