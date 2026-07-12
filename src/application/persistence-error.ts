export type PersistenceErrorCode =
  | "invite_not_found"
  | "employee_already_linked"
  | "chat_already_linked"
  | "participant_not_found"
  | "session_not_found"
  | "consent_required"
  | "profile_not_found"
  | "message_not_found"
  | "persistence_unavailable"
  | "persistence_conflict";

export class PersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode) {
    super(code);
    this.name = "PersistenceError";
  }
}

type PostgresError = { code?: string; constraint?: string };

/** Maps driver errors at the infrastructure boundary; SQL text never escapes it. */
export function mapPostgresError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const postgres = error as PostgresError;
  if (postgres.code === "23505") return new PersistenceError("persistence_conflict");
  // These indicate a caller/data invariant violation, not a transient outage.
  if (["23502", "23503", "23514"].includes(postgres.code ?? "")) {
    return new PersistenceError("persistence_conflict");
  }
  return new PersistenceError("persistence_unavailable");
}
