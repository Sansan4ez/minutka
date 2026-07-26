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
    async save(summary) {
      const index = world.threadSummaries.findIndex(
        (candidate) => candidate.employeeId === summary.employeeId && candidate.threadId === summary.threadId,
      );
      if (index < 0) world.threadSummaries.push(copy(summary));
      else world.threadSummaries[index] = copy(summary);
    },
  };
}

function copy(summary: ThreadSummary): ThreadSummary {
  return { ...summary, watermark: { ...summary.watermark } };
}
