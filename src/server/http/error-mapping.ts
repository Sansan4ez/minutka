import { randomUUID } from "node:crypto";
import { PersistenceError, type PersistenceErrorCode } from "../../application/persistence-error.js";
import { AssistantContextOverflowError } from "../../application/assistant-overflow-recovery.js";
import type { ApiErrorCode } from "../../contracts/minutka-api.js";

export type HttpError = { status: number; code: ApiErrorCode; message: string };
const persistenceStatuses: Record<PersistenceErrorCode, number> = {
  invite_not_found: 404, participant_not_found: 404, profile_not_found: 404, message_not_found: 404, session_not_found: 404,
  employee_already_linked: 409, chat_already_linked: 409, consent_required: 409, profile_already_completed: 409, persistence_conflict: 409,
  persistence_unavailable: 503,
};
export class RequestError extends Error { constructor(readonly http: HttpError) { super(http.message); } }
export const httpError = (status: number, code: ApiErrorCode, message: string) => new RequestError({ status, code, message });
export function requestId(): string { return `req_${randomUUID()}`; }
export function mapError(error: unknown): HttpError {
  if (error instanceof RequestError) return error.http;
  if (error instanceof PersistenceError) return { status: persistenceStatuses[error.code], code: error.code, message: safeMessage(error.code) };
  if (error instanceof AssistantContextOverflowError) return { status: 413, code: error.code, message: error.message };
  return { status: 500, code: "internal_error", message: "Internal server error." };
}
function safeMessage(code: ApiErrorCode): string {
  if (code === "consent_required") return "Privacy consent is required.";
  if (code === "persistence_unavailable") return "Service is temporarily unavailable.";
  if (code.endsWith("_not_found")) return "Requested resource was not found.";
  if (code.includes("linked") || code.includes("conflict")) return "The request conflicts with existing state.";
  return "Request could not be completed.";
}
