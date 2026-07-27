import type { InMemoryWorld } from "./in-memory-world.js";
import type { ThreadSummary, ThreadSummaryStore } from "./thread-summary-store.js";

export function createInMemoryThreadSummaryStore(world: InMemoryWorld): ThreadSummaryStore {
  return {
    async get({ employeeId, threadId }) {
      const summary = world.threadSummaries.find(
        (candidate) => candidate.employeeId === employeeId && candidate.threadId === threadId,
      );
      return summary ? copy(summary) : undefined;
    },
    async save(summary, expectedThroughMessageId) {
      const index = world.threadSummaries.findIndex(
        (candidate) => candidate.employeeId === summary.employeeId && candidate.threadId === summary.threadId,
      );
      const existing = index < 0 ? undefined : world.threadSummaries[index];
      if (expectedThroughMessageId === undefined ? existing !== undefined : existing?.watermark.throughMessageId !== expectedThroughMessageId) {
        return "conflict";
      }
      if (index < 0) world.threadSummaries.push(copy(summary));
      else world.threadSummaries[index] = copy(summary);
      return "saved";
    },
  };
}

function copy(summary: ThreadSummary): ThreadSummary {
  return { ...summary, watermark: { ...summary.watermark } };
}
