export type AssistantTimeoutBudgets = {
  /** Whole AssistantService turn budget, including agent/tool execution and deterministic recovery. */
  applicationMs: number;
  /** Last server-side emergency bound for the HTTP chat handler. */
  httpChatHandlerMs: number;
  /** SDK wait budget used by Telegram and other HTTP clients. */
  sdkTransportMs: number;
  /** Node HTTP server request timeout. */
  serverRequestMs: number;
};

/**
 * Leave bounded recovery time after agent cancellation and bounded transport
 * time after the HTTP handler has produced its response.
 */
export const productionAssistantTimeoutBudgets: AssistantTimeoutBudgets = {
  applicationMs: 75_000,
  httpChatHandlerMs: 100_000,
  sdkTransportMs: 110_000,
  serverRequestMs: 120_000,
};

export function assertAssistantTimeoutBudgets(budgets: AssistantTimeoutBudgets): AssistantTimeoutBudgets {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Assistant timeout budget ${name} must be a positive safe integer.`);
  }
  if (!(budgets.applicationMs < budgets.httpChatHandlerMs
    && budgets.httpChatHandlerMs < budgets.sdkTransportMs
    && budgets.sdkTransportMs < budgets.serverRequestMs)) {
    throw new Error("Assistant timeout budgets must satisfy application < HTTP handler < SDK transport < server request timeout.");
  }
  return budgets;
}
