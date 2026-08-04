import {
  copyPendingActionGroup,
  validatePendingActionGroup,
  type PendingActionGroup,
  type PendingActionGroupStore,
} from "./pending-action-group-store.js";

export function createInMemoryPendingActionGroupStore(options: { now?: () => string } = {}): PendingActionGroupStore {
  const groups = new Map<string, PendingActionGroup>();
  const now = options.now ?? (() => new Date().toISOString());
  const key = (ownerId: string, groupId: string) => `${ownerId}\u0000${groupId}`;
  const current = (ownerId: string, groupId: string) => groups.get(key(ownerId, groupId));
  const save = (group: PendingActionGroup) => {
    const validated = validatePendingActionGroup(group);
    groups.set(key(validated.ownerId, validated.groupId), validated);
    return copyPendingActionGroup(validated);
  };
  return {
    async create(input) {
      const group = validatePendingActionGroup({ ...input, state: "preparing" });
      const groupKey = key(group.ownerId, group.groupId);
      if (groups.has(groupKey)) throw new Error("Pending action group already exists");
      groups.set(groupKey, group);
      return copyPendingActionGroup(group);
    },
    async markDelivered({ ownerId, groupId, messageId }) {
      const group = current(ownerId, groupId);
      if (!group || group.state === "completed" || group.state === "cancelled" || Date.parse(group.expiresAt) <= Date.parse(now())) return undefined;
      if (group.messageId !== undefined && group.messageId !== messageId) return undefined;
      return save({ ...group, state: "delivered", messageId });
    },
    async get(ownerId, groupId) {
      const group = current(ownerId, groupId);
      return group ? copyPendingActionGroup(group) : undefined;
    },
    async getLatestDelivered(ownerId) {
      return [...groups.values()]
        .filter((group) => group.ownerId === ownerId && group.state === "delivered" && Date.parse(group.expiresAt) > Date.parse(now()))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.groupId.localeCompare(left.groupId))
        .map(copyPendingActionGroup)[0];
    },
    async markItemsResolved({ ownerId, groupId, ordinals }) {
      const group = current(ownerId, groupId);
      if (!group || group.state !== "delivered") return undefined;
      const resolved = new Set(ordinals);
      return save({ ...group, items: group.items.map((item) => resolved.has(item.ordinal) ? { ...item, state: "resolved" } : item) });
    },
    async complete(ownerId, groupId) {
      const group = current(ownerId, groupId);
      if (!group || group.state === "cancelled") return undefined;
      return save({ ...group, state: "completed" });
    },
    async cancel(ownerId, groupId) {
      const group = current(ownerId, groupId);
      if (!group || group.state === "completed") return undefined;
      return save({ ...group, state: "cancelled" });
    },
    async purgeExpired({ limit = 500 } = {}) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Pending action group purge limit must be positive");
      const expired = [...groups.entries()]
        .filter(([, group]) => Date.parse(group.expiresAt) <= Date.parse(now()))
        .sort(([, left], [, right]) => left.expiresAt.localeCompare(right.expiresAt) || left.groupId.localeCompare(right.groupId))
        .slice(0, limit);
      for (const [groupKey] of expired) groups.delete(groupKey);
      return expired.length;
    },
  };
}
