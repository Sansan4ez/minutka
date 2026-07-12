import type { InsightKind, StructuredInsight } from "../domain/insights.js";

export type InsightStore = {
  saveInsights(insights: StructuredInsight[]): Promise<void>;
  listInsights(input: {
    employeeId?: string;
    threadId?: string;
    kind?: InsightKind;
    limit?: number;
  }): Promise<StructuredInsight[]>;
};
