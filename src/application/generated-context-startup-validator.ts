import { renderEmptyAssistantContextSection } from "./assistant-context-renderer.js";
import {
  countUnicodeCharacters,
  sourceCharacterCeiling,
  type ContextBudgetConfig,
  type ContextSourceId,
} from "./context-budget.js";
import { renderEmptyContextTreeIndex } from "./context-tree-index.js";

/**
 * Rejects source ceilings that cannot hold generated sections even when the
 * authenticated owner has no context documents.
 */
export function assertGeneratedContextSourceMinimums(config: ContextBudgetConfig): void {
  const generatedSections: ReadonlyArray<{ sourceId: ContextSourceId; content: string }> = [
    { sourceId: "context", content: renderEmptyAssistantContextSection() },
    { sourceId: "context_index", content: renderEmptyContextTreeIndex(config.projectionLimits.contextIndexDepth) },
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
