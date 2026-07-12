export type PersistenceErrorCode =
  | "invite_not_found"
  | "invite_conflict"
  | "employee_already_linked"
  | "chat_already_linked"
  | "participant_not_found"
  | "consent_required"
  | "profile_not_found"
  | "message_not_found"
  | "persistence_unavailable"
  | "persistence_conflict";

export class PersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode, message = code) {
    super(message);
    this.name = "PersistenceError";
  }
}

export function mapPostgresError(error: unknown): PersistenceError {
  const code = (error as { code?: string; constraint?: string }).code;
  if (code === "23505") return new PersistenceError("persistence_conflict");
  if (code === "57014" || code === "08000" || code === "08006") return new PersistenceError("persistence_unavailable");
  return new PersistenceError("persistence_unavailable");
}
