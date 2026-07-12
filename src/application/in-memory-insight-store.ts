import type { InsightKind, StructuredInsight } from "../domain/insights.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { InsightStore } from "./insight-store.js";

export function createInMemoryInsightStore(world: InMemoryWorld): InsightStore {
  return {
    async saveInsights(insights) {
      for (const insight of insights) {
        if (!world.insights.some((existing) => existing.id === insight.id)) world.insights.push(insight);
      }
    },
    async listInsights(input: {
      employeeId?: string;
      threadId?: string;
      kind?: InsightKind;
      limit?: number;
    }) {
      const matches = world.insights.filter(
        (insight) =>
          (!input.employeeId || insight.employeeId === input.employeeId) &&
          (!input.threadId || insight.threadId === input.threadId) &&
          (!input.kind || insight.kind === input.kind),
      );
      return input.limit === undefined ? matches : matches.slice(-Math.max(0, input.limit));
    },
  };
}
