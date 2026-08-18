import { parseEvaluationCase, type EvaluationCaseRecord, type EvaluationCaseStore } from "./research-evaluation.js";
import { createTenantSubjectScopeIndex, type TenantSubjectScopeIndex } from "./tenant-subject-scope.js";

export type InMemoryEvaluationCaseState = { cases: EvaluationCaseRecord[] };
export function createInMemoryEvaluationCaseState(): InMemoryEvaluationCaseState { return { cases: [] }; }

export function createInMemoryEvaluationCaseStore(
  state: InMemoryEvaluationCaseState,
  options: { tenantScope?: TenantSubjectScopeIndex } = {},
): EvaluationCaseStore {
  const tenantScope = options.tenantScope ?? createTenantSubjectScopeIndex();
  return {
    async create(input) {
      if (state.cases.some((record) => record.caseId === input.caseId)) throw new Error("evaluation case already exists");
      tenantScope.bindSubject(input);
      tenantScope.bindTrace(input.traceId, input);
      state.cases.push(structuredClone(parseEvaluationCase(input)));
    },
    async get({ companyId, groupId, caseId }) {
      const record = state.cases.find((candidate) => candidate.companyId === companyId && candidate.groupId === groupId && candidate.caseId === caseId);
      return record ? structuredClone(record) : undefined;
    },
    async list({ companyId, groupId }) {
      return state.cases.filter((record) => record.companyId === companyId && record.groupId === groupId).map((record) => structuredClone(record));
    },
  };
}
