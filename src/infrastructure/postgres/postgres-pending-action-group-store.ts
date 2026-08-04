import type { Pool } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  copyPendingActionGroup,
  validatePendingActionGroup,
  type PendingActionGroup,
  type PendingActionGroupItem,
  type PendingActionGroupStore,
} from "../../telegram/pending-action-group-store.js";

type Row = {
  group_id: string;
  owner_id: string;
  items: unknown;
  state: PendingActionGroup["state"];
  message_id: string | number | null;
  created_at: Date;
  expires_at: Date;
};

export function createPostgresPendingActionGroupStore(pool: Pool): PendingActionGroupStore {
  const select = async (ownerId: string, groupId: string): Promise<PendingActionGroup | undefined> => {
    const result = await pool.query<Row>(
      `SELECT group_id, owner_id, items, state, message_id, created_at, expires_at
       FROM minutka_private.telegram_pending_action_groups
       WHERE owner_id = $1 AND group_id = $2`,
      [ownerId, groupId],
    );
    return result.rows[0] ? restore(result.rows[0]) : undefined;
  };
  return {
    async create(input) {
      const group = validatePendingActionGroup({ ...input, state: "preparing" });
      try {
        await pool.query(
          `INSERT INTO minutka_private.telegram_pending_action_groups
            (group_id, owner_id, items, state, created_at, expires_at)
           VALUES ($1, $2, $3::jsonb, 'preparing', $4, $5)`,
          [group.groupId, group.ownerId, JSON.stringify(group.items), group.createdAt, group.expiresAt],
        );
        return copyPendingActionGroup(group);
      } catch (error) { throw mapPostgresError(error); }
    },
    async markDelivered({ ownerId, groupId, messageId }) {
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.telegram_pending_action_groups
           SET state = 'delivered', message_id = $3
           WHERE owner_id = $1 AND group_id = $2
             AND state IN ('preparing', 'delivered')
             AND expires_at > now()
             AND (message_id IS NULL OR message_id = $3)
           RETURNING group_id, owner_id, items, state, message_id, created_at, expires_at`,
          [ownerId, groupId, messageId],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async get(ownerId, groupId) {
      try { return await select(ownerId, groupId); }
      catch (error) { throw mapPostgresError(error); }
    },
    async getLatestDelivered(ownerId) {
      try {
        const result = await pool.query<Row>(
          `SELECT group_id, owner_id, items, state, message_id, created_at, expires_at
           FROM minutka_private.telegram_pending_action_groups
           WHERE owner_id = $1 AND state = 'delivered' AND expires_at > now()
           ORDER BY created_at DESC, group_id DESC
           LIMIT 1`,
          [ownerId],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async markItemsResolved({ ownerId, groupId, ordinals }) {
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.telegram_pending_action_groups
           SET items = (
             SELECT jsonb_agg(
               CASE WHEN (item->>'ordinal')::integer = ANY($3::integer[])
                 THEN jsonb_set(item, '{state}', '"resolved"'::jsonb, false)
                 ELSE item END
               ORDER BY (item->>'ordinal')::integer
             )
             FROM jsonb_array_elements(items) AS item
           )
           WHERE owner_id = $1 AND group_id = $2
             AND state = 'delivered'
           RETURNING group_id, owner_id, items, state, message_id, created_at, expires_at`,
          [ownerId, groupId, ordinals],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async complete(ownerId, groupId) {
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.telegram_pending_action_groups
           SET state = 'completed'
           WHERE owner_id = $1 AND group_id = $2 AND state <> 'cancelled'
           RETURNING group_id, owner_id, items, state, message_id, created_at, expires_at`,
          [ownerId, groupId],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async cancel(ownerId, groupId) {
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.telegram_pending_action_groups
           SET state = 'cancelled'
           WHERE owner_id = $1 AND group_id = $2 AND state <> 'completed'
           RETURNING group_id, owner_id, items, state, message_id, created_at, expires_at`,
          [ownerId, groupId],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async purgeExpired({ limit = 500 } = {}) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Pending action group purge limit must be positive");
      try {
        const result = await pool.query(
          `WITH candidates AS (
             SELECT group_id FROM minutka_private.telegram_pending_action_groups
             WHERE expires_at <= now()
             ORDER BY expires_at, group_id
             LIMIT $1 FOR UPDATE SKIP LOCKED
           )
           DELETE FROM minutka_private.telegram_pending_action_groups groups
           USING candidates WHERE groups.group_id = candidates.group_id`,
          [limit],
        );
        return result.rowCount ?? 0;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

function restore(row: Row): PendingActionGroup {
  if (!Array.isArray(row.items)) throw new Error("invalid stored pending action group items");
  const messageId = row.message_id === null ? undefined : Number(row.message_id);
  return validatePendingActionGroup({
    groupId: row.group_id,
    ownerId: row.owner_id,
    items: row.items as PendingActionGroupItem[],
    state: row.state,
    ...(messageId === undefined ? {} : { messageId }),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
}
