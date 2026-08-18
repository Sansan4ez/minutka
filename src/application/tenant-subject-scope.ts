import { PersistenceError } from "./persistence-error.js";

/** The tuple pinned by the composite keys on `minutka_private.participants`. */
export type TenantSubjectScope = {
  companyId: string;
  groupId: string;
  subjectKey: string;
};

export type TenantSubjectScopeIndex = {
  /** A research subject belongs to exactly one company and group. */
  bindSubject(scope: TenantSubjectScope): void;
  /** An employee's canonical records carry that employee's own subject. */
  bindOwner(employeeId: string, scope: TenantSubjectScope): void;
  /** A trace-linked record carries the tuple of its trace, not only its id. */
  bindTrace(traceId: string, scope: TenantSubjectScope): void;
};

/**
 * In-memory mirror of the composite tenant/subject foreign keys in the canonical
 * schema (`migrations/0062_bind_tenant_subject_tuples.sql`). Adapters over one
 * fixture share an index, so a cross-tenant tuple fails the way PostgreSQL fails
 * it — as `persistence_conflict`, before the record becomes observable.
 */
export function createTenantSubjectScopeIndex(): TenantSubjectScopeIndex {
  const bound = new Map<string, TenantSubjectScope>();
  const bind = (key: string, scope: TenantSubjectScope): void => {
    const known = bound.get(key);
    if (!known) {
      bound.set(key, { companyId: scope.companyId, groupId: scope.groupId, subjectKey: scope.subjectKey });
      return;
    }
    if (known.companyId !== scope.companyId || known.groupId !== scope.groupId || known.subjectKey !== scope.subjectKey) {
      throw new PersistenceError("persistence_conflict");
    }
  };
  return {
    bindSubject: (scope) => bind(`subject:${scope.subjectKey}`, scope),
    bindOwner: (employeeId, scope) => bind(`employee:${employeeId}`, scope),
    bindTrace: (traceId, scope) => bind(`trace:${traceId}`, scope),
  };
}
