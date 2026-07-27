export type AssistantMutationEffectState = "none" | "attempted" | "committed";

export const mutationOutcomeUnknownUserMessage =
  "Не удалось подтвердить сохранение идеи. Проверьте список идей перед повторной отправкой, чтобы не создать дубль.";

export function mutationOutcomeUserMessage(error: unknown): string | undefined {
  if (error instanceof AssistantMutationOutcomeUnknownError) return mutationOutcomeUnknownUserMessage;
  return error instanceof Error && "code" in error && error.code === "mutation_outcome_unknown"
    ? mutationOutcomeUnknownUserMessage
    : undefined;
}

/**
 * The non-idempotent write was started, but its durable result could not be
 * observed. Callers must reconcile by reading before deciding to write again.
 */
export class AssistantMutationOutcomeUnknownError extends Error {
  readonly code = "mutation_outcome_unknown" as const;

  constructor(options: { cause?: unknown } = {}) {
    super(mutationOutcomeUnknownUserMessage, options);
    this.name = "AssistantMutationOutcomeUnknownError";
  }
}
