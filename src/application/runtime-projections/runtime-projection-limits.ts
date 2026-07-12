export const runtimeProjectionLimits = {
  threadTurns: 10,
  threadCharacters: 12_000,
  /** Individual user/assistant fields are clipped before a turn is budgeted. */
  threadTurnTextCharacters: 6_000,
  insights: 20,
  feedback: 20,
  runCurrent: 50,
  runRecent: 50,
} as const;
