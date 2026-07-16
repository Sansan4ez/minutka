import type { RequestIntegrityOutcome } from "../domain/request-integrity.js";

export type RequestIntegrityGuardInput = {
  /** Trusted transport identity. It is context for the guard, never model-controlled authority. */
  userId: string;
  /** Only the current user request is evaluated. Stored projections and history remain quoted data. */
  text: string;
};

export type RequestIntegrityGuard = (
  input: RequestIntegrityGuardInput,
) => Promise<RequestIntegrityOutcome>;
