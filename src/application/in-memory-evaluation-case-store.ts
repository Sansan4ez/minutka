import { parseEvaluationCase, type EvaluationCaseRecord, type EvaluationCaseStore } from "./research-evaluation.js";

export type InMemoryEvaluationCaseState = { cases: EvaluationCaseRecord[] };
export function createInMemoryEvaluationCaseState(): InMemoryEvaluationCaseState { return { cases: [] }; }

export function createInMemoryEvaluationCaseStore(state: InMemoryEvaluationCaseState): EvaluationCaseStore {
  return {
    async create(input) {
      if (state.cases.some((record) => record.caseId === input.caseId)) throw new Error("evaluation case already exists");
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
