import { pendingActionSchema } from "../contracts/minutka-api.js";
import type { AssistantPendingAction } from "../application/assistant-service.js";

export type PendingActionGroupOrdinal = 1 | 2 | 3 | 4 | 5;
export type PendingActionGroupItem = {
  ordinal: PendingActionGroupOrdinal;
  action: AssistantPendingAction;
  state: "pending" | "resolved";
};
export type PendingActionGroupState = "preparing" | "delivered" | "completed" | "cancelled";
export type PendingActionGroup = {
  groupId: string;
  ownerId: string;
  items: PendingActionGroupItem[];
  state: PendingActionGroupState;
  messageId?: number;
  createdAt: string;
  expiresAt: string;
};

export interface PendingActionGroupStore {
  create(input: Omit<PendingActionGroup, "state" | "messageId">): Promise<PendingActionGroup>;
  /** Binds the delivered Telegram message; the same binding is idempotent. */
  markDelivered(input: { ownerId: string; groupId: string; messageId: number }): Promise<PendingActionGroup | undefined>;
  get(ownerId: string, groupId: string): Promise<PendingActionGroup | undefined>;
  /** Returns only a non-expired delivered group, newest first. */
  getLatestDelivered(ownerId: string): Promise<PendingActionGroup | undefined>;
  markItemsResolved(input: { ownerId: string; groupId: string; ordinals: PendingActionGroupOrdinal[] }): Promise<PendingActionGroup | undefined>;
  complete(ownerId: string, groupId: string): Promise<PendingActionGroup | undefined>;
  cancel(ownerId: string, groupId: string): Promise<PendingActionGroup | undefined>;
  purgeExpired(input?: { limit?: number }): Promise<number>;
}

export function validatePendingActionGroup(group: PendingActionGroup): PendingActionGroup {
  const groupId = requiredText(group.groupId, "groupId");
  const ownerId = requiredText(group.ownerId, "ownerId");
  const createdAt = isoInstant(group.createdAt, "createdAt");
  const expiresAt = isoInstant(group.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new RangeError("Pending action group must expire after creation");
  if (!(["preparing", "delivered", "completed", "cancelled"] as const).includes(group.state)) throw new RangeError("Invalid pending action group state");
  if ((group.state === "delivered" || group.state === "completed") && group.messageId === undefined) throw new RangeError("Delivered pending action group requires messageId");
  if (group.state === "preparing" && group.messageId !== undefined) throw new RangeError("Preparing pending action group cannot have messageId");
  if (group.messageId !== undefined && (!Number.isSafeInteger(group.messageId) || group.messageId <= 0)) throw new RangeError("Pending action group messageId must be a positive safe integer");
  if (!Array.isArray(group.items) || group.items.length < 1 || group.items.length > 5) throw new RangeError("Pending action group must contain between one and five items");
  const items = group.items.map((item, index): PendingActionGroupItem => {
    const ordinal = index + 1;
    if (item.ordinal !== ordinal) throw new RangeError("Pending action group ordinals must be contiguous and immutable");
    if (item.state !== "pending" && item.state !== "resolved") throw new RangeError("Invalid pending action group item state");
    const action = pendingActionSchema.parse(item.action) as AssistantPendingAction;
    if (Date.parse(action.expiresAt) > Date.parse(expiresAt)) throw new RangeError("Pending action group expires before one of its items");
    return { ordinal: ordinal as PendingActionGroupOrdinal, action, state: item.state };
  });
  const maximumItemExpiry = Math.max(...items.map(({ action }) => Date.parse(action.expiresAt)));
  if (maximumItemExpiry !== Date.parse(expiresAt)) throw new RangeError("Pending action group expiry must equal the latest item expiry");
  return {
    groupId,
    ownerId,
    items,
    state: group.state,
    ...(group.messageId === undefined ? {} : { messageId: group.messageId }),
    createdAt,
    expiresAt,
  };
}

export function copyPendingActionGroup(group: PendingActionGroup): PendingActionGroup {
  return structuredClone(validatePendingActionGroup(group));
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${field} is required`);
  return normalized;
}

function isoInstant(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`${field} must be an ISO timestamp`);
  return value;
}
