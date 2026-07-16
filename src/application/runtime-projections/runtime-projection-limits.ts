import { defaultContextBudget, sourceCharacterCeiling, type ContextBudgetConfig } from "../context-budget.js";

export type RuntimeProjectionLimits = {
  threadTurns: number;
  threadCharacters: number;
  threadTurnTextCharacters: number;
  insights: number;
  feedback: number;
  runCurrent: number;
  runRecent: number;
};

export function runtimeProjectionLimitsFromBudget(config: ContextBudgetConfig = defaultContextBudget): RuntimeProjectionLimits {
  return {
    threadTurns: config.projectionLimits.historyTurns,
    threadCharacters: sourceCharacterCeiling(config, "history"),
    /** Individual user/assistant fields are clipped before a turn is budgeted. */
    threadTurnTextCharacters: config.projectionLimits.historyTurnCharacters,
    insights: config.projectionLimits.insights,
    feedback: config.projectionLimits.feedback,
    runCurrent: config.projectionLimits.runCurrent,
    runRecent: config.projectionLimits.runRecent,
  };
}

export const runtimeProjectionLimits = runtimeProjectionLimitsFromBudget();
