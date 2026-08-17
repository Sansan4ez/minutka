/**
 * The requested role belongs to another company. This is a caller error on the
 * second isolation axis, so the boundary reports it as a contract refusal with
 * a visible reason instead of an unknown runtime failure.
 */
export class RoleNotInCompanyError extends Error {
  constructor() {
    super("roleId must belong to the participant company");
    this.name = "RoleNotInCompanyError";
  }
}
