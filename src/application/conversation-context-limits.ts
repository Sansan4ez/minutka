import { defaultContextBudget, sourceCharacterCeiling } from "./context-budget.js";

export const conversationContextLimits = {
  /** Wider context rendered for the response-generating agent. */
  responseTurns: defaultContextBudget.projectionLimits.historyTurns,
  responseCharacters: sourceCharacterCeiling(defaultContextBudget, "history"),
  responseFieldCharacters: defaultContextBudget.projectionLimits.historyTurnCharacters,
  /** Local intent window used by the business-process decision router. */
  routingTurns: defaultContextBudget.projectionLimits.routingTurns,
  routingCurrentTextCharacters: defaultContextBudget.projectionLimits.routingCurrentTextCharacters,
  routingTurnFieldCharacters: defaultContextBudget.projectionLimits.routingTurnFieldCharacters,
  /** Context used after the response for structured insight extraction. */
  insightTurns: defaultContextBudget.projectionLimits.insightTurns,
  insightFieldCharacters: defaultContextBudget.projectionLimits.insightFieldCharacters,
} as const;
