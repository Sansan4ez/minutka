export const conversationContextLimits = {
  /** Wider context rendered for the response-generating agent. */
  responseTurns: 10,
  responseCharacters: 12_000,
  responseFieldCharacters: 6_000,
  /** Local intent window used by the business-process decision router. */
  routingTurns: 3,
  routingCurrentTextCharacters: 4_096,
  routingTurnFieldCharacters: 700,
  /** Context used after the response for structured insight extraction. */
  insightTurns: 5,
  insightFieldCharacters: 2_000,
} as const;
