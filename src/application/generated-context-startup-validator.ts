import { renderEmptyAssistantContextSection } from "./assistant-context-renderer.js";
import { renderAssistantAgentManual, renderAssistantBaseInstructions } from "./assistant-static-context.js";
import {
  countUnicodeCharacters,
  sourceCharacterCeiling,
  type ContextBudgetConfig,
  type ContextSourceId,
} from "./context-budget.js";
import { renderEmptyContextTreeIndex } from "./context-tree-index.js";
import { renderThreadSummaryProjection } from "./runtime-projections/runtime-projection-renderer.js";
import { canonicalThreadSummaryWatermark, minimumThreadSummaryText } from "./thread-summarizer.js";
import { renderMaximumResponsePolicy } from "../domain/response-policy.js";

/**
 * Rejects source ceilings that cannot hold generated sections even when the
 * authenticated owner has no context documents.
 */
export function assertGeneratedContextSourceMinimums(config: ContextBudgetConfig, agentInstructions: string): void {
  const generatedSections: ReadonlyArray<{ sourceId: ContextSourceId; content: string }> = [
    { sourceId: "base_instructions", content: renderAssistantBaseInstructions() },
    {
      sourceId: "agent_manual",
      content: renderAssistantAgentManual(agentInstructions, renderMaximumResponsePolicy()),
    },
    { sourceId: "context", content: renderEmptyAssistantContextSection() },
    { sourceId: "context_index", content: renderEmptyContextTreeIndex(config.projectionLimits.contextIndexDepth) },
    {
      sourceId: "thread_summary",
      content: renderThreadSummaryProjection({
        summary: {
          employeeId: "owner",
          threadId: "thread",
          text: minimumThreadSummaryText,
          watermark: canonicalThreadSummaryWatermark,
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
        turns: [],
        truncated: false,
      }),
    },
  ];

  for (const section of generatedSections) {
    const minimum = countUnicodeCharacters(section.content);
    const ceiling = sourceCharacterCeiling(config, section.sourceId);
    if (ceiling < minimum) {
      throw new Error(
        `context source ${section.sourceId} requires a minimum rendered representation of ${minimum} Unicode characters, but its configured ceiling is ${ceiling}`,
      );
    }
  }
}
