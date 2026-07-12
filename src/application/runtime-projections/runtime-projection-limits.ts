import { conversationContextLimits } from "../conversation-context-limits.js";

export const runtimeProjectionLimits = {
  threadTurns: conversationContextLimits.responseTurns,
  threadCharacters: conversationContextLimits.responseCharacters,
  /** Individual user/assistant fields are clipped before a turn is budgeted. */
  threadTurnTextCharacters: conversationContextLimits.responseFieldCharacters,
  insights: 20,
  feedback: 20,
  runCurrent: 50,
  runRecent: 50,
} as const;
