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
import { assistantDiagnosticProcessIds } from "../domain/assistant-process.js";

/**
 * Minimum rendered representation of every generated source, computed by running
 * the production renderers rather than by restating magic constants. Exported so
 * budget specs can assert headroom against the exact number the startup check
 * uses; `vault/assistant` growth then fails `npm run verify`, not a production
 * restart.
 */
export function generatedContextSourceMinimums(
  config: ContextBudgetConfig,
  agentInstructions: string,
): ReadonlyArray<{ sourceId: ContextSourceId; minimum: number }> {
  return generatedContextSections(config, agentInstructions).map(({ sourceId, content }) => ({
    sourceId,
    minimum: countUnicodeCharacters(content),
  }));
}

/**
 * Rejects source ceilings that cannot hold generated sections even when the
 * authenticated owner has no context documents.
 */
export function assertGeneratedContextSourceMinimums(config: ContextBudgetConfig, agentInstructions: string): void {
  for (const { sourceId, minimum } of generatedContextSourceMinimums(config, agentInstructions)) {
    const ceiling = sourceCharacterCeiling(config, sourceId);
    if (ceiling < minimum) {
      throw new Error(
        `context source ${sourceId} requires a minimum rendered representation of ${minimum} Unicode characters, but its configured ceiling is ${ceiling}`,
      );
    }
  }
}

function generatedContextSections(
  config: ContextBudgetConfig,
  agentInstructions: string,
): ReadonlyArray<{ sourceId: ContextSourceId; content: string }> {
  return [
    {
      sourceId: "base_instructions",
      content: renderAssistantBaseInstructions(),
    },
    {
      sourceId: "agent_manual",
      content: assistantDiagnosticProcessIds.reduce(
        (longest, processId) => {
          const rendered = renderAssistantAgentManual(agentInstructions, renderMaximumResponsePolicy(), processId);
          return countUnicodeCharacters(rendered) > countUnicodeCharacters(longest) ? rendered : longest;
        },
        renderAssistantAgentManual(agentInstructions, renderMaximumResponsePolicy()),
      ),
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
}
