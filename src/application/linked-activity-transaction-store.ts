import type { RetrospectiveScope } from "../domain/work-retrospective.js";
import type { ActivityTransactionServiceResult } from "./activity-transaction-service.js";

/** Claim before generation/write. A reserved key without an outcome is unknown,
 * not permission to retry. Each write has its own ordinal (0 is extraction).
 */
export type LinkedActivityTransactionKey = RetrospectiveScope & { sourceMessageId: string; ordinal: number };
export type LinkedActivityTransactionStore = {
  claim(key: LinkedActivityTransactionKey): Promise<{ status: "claimed" } | { status: "existing"; outcome?: ActivityTransactionServiceResult }>;
  complete(key: LinkedActivityTransactionKey, outcome: ActivityTransactionServiceResult): Promise<void>;
};
export function createInMemoryLinkedActivityTransactionStore(): LinkedActivityTransactionStore {
  const entries = new Map<string, ActivityTransactionServiceResult | undefined>();
  const keyOf = (key: LinkedActivityTransactionKey) => JSON.stringify([key.employeeId, key.companyId, key.groupId, key.subjectKey, key.threadId, key.sourceMessageId, key.ordinal]);
  return {
    async claim(key) {
      const id = keyOf(key);
      if (entries.has(id)) {
        const outcome = entries.get(id);
        return { status: "existing", ...(outcome ? { outcome: structuredClone(outcome) } : {}) };
      }
      entries.set(id, undefined);
      return { status: "claimed" };
    },
    async complete(key, outcome) {
      const id = keyOf(key);
      if (!entries.has(id) || entries.get(id)) throw new Error("Linked transaction was not reserved or is already complete");
      entries.set(id, structuredClone(outcome));
    },
  };
}
