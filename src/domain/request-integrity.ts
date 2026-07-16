export const requestIntegrityDenialReasons = [
  "authority_override",
  "check_evasion",
  "authority_impersonation",
  "identity_substitution",
  "forbidden_action_laundering",
] as const;

export type RequestIntegrityDenialReason = (typeof requestIntegrityDenialReasons)[number];

/** Trusted application outcome produced before any business-capable agent run. */
export type RequestIntegrityOutcome =
  | { status: "allowed" }
  | { status: "denied"; reason: RequestIntegrityDenialReason };
