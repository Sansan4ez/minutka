import type { RequestIntegrityOutcome } from "../domain/request-integrity.js";
import type { ModelTokenUsage } from "./usage-store.js";

export type RequestIntegrityGuardInput = {
  /** Trusted transport identity. It is context for the guard, never model-controlled authority. */
  userId: string;
  /** Only the current user request is evaluated. Stored projections and history remain quoted data. */
  text: string;
};

/** The guard is a billed LLM call, so it reports its own token usage for attribution. */
export type RequestIntegrityGuardResult = RequestIntegrityOutcome & { usage?: ModelTokenUsage };

export type RequestIntegrityGuard = (
  input: RequestIntegrityGuardInput,
) => Promise<RequestIntegrityGuardResult>;
