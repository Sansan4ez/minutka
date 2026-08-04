import { describe, expect, it } from "vitest";
import { createInMemoryPendingActionGroupStore } from "../../../src/telegram/in-memory-pending-action-group-store.js";

const action = (confirmationId: string) => ({
  confirmationId,
  actionKind: "cancel" as const,
  summary: `Отменить ${confirmationId}`,
  expiresAt: "2026-08-04T12:15:00.000Z",
  preview: {
    kind: "cancel" as const,
    taskId: { value: confirmationId, truncated: false },
    taskTitle: { value: confirmationId, truncated: false },
  },
});

describe("SPEC-PENDING-ACTION-GROUP-STORE-001: restart-safe group transport state", () => {
  it("does not expose preparing groups to text lookup but accepts callback delivery proof", async () => {
    let now = "2026-08-04T12:00:00.000Z";
    const store = createInMemoryPendingActionGroupStore({ now: () => now });
    await store.create({
      groupId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      ownerId: "owner-a",
      items: [
        { ordinal: 1, action: action("confirmation-1"), state: "pending" },
        { ordinal: 2, action: action("confirmation-2"), state: "pending" },
      ],
      createdAt: now,
      expiresAt: "2026-08-04T12:15:00.000Z",
    });

    await expect(store.getLatestDelivered("owner-a")).resolves.toBeUndefined();
    await expect(store.markDelivered({ ownerId: "owner-b", groupId: "bbbbbbbbbbbbbbbbbbbbbbbb", messageId: 7 })).resolves.toBeUndefined();
    await expect(store.markDelivered({ ownerId: "owner-a", groupId: "bbbbbbbbbbbbbbbbbbbbbbbb", messageId: 7 })).resolves.toMatchObject({ state: "delivered", messageId: 7 });
    await expect(store.markDelivered({ ownerId: "owner-a", groupId: "bbbbbbbbbbbbbbbbbbbbbbbb", messageId: 8 })).resolves.toBeUndefined();
    await expect(store.getLatestDelivered("owner-a")).resolves.toMatchObject({ groupId: "bbbbbbbbbbbbbbbbbbbbbbbb" });

    await store.markItemsResolved({ ownerId: "owner-a", groupId: "bbbbbbbbbbbbbbbbbbbbbbbb", ordinals: [1] });
    await expect(store.get("owner-a", "bbbbbbbbbbbbbbbbbbbbbbbb")).resolves.toMatchObject({ items: [{ state: "resolved" }, { state: "pending" }] });
    now = "2026-08-04T12:16:00.000Z";
    await expect(store.getLatestDelivered("owner-a")).resolves.toBeUndefined();
    await expect(store.purgeExpired({ limit: 1 })).resolves.toBe(1);
  });
});
