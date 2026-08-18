import type { ResearchTraceRecord, ResearchTraceStore } from "./research-trace-store.js";
import { sanitizeResearchTrace } from "./research-trace-store.js";
import { createTenantSubjectScopeIndex, type TenantSubjectScopeIndex } from "./tenant-subject-scope.js";

export type InMemoryResearchTraceState = {
  traces: ResearchTraceRecord[];
};

export function createInMemoryResearchTraceState(): InMemoryResearchTraceState {
  return { traces: [] };
}

export function createInMemoryResearchTraceStore(
  state: InMemoryResearchTraceState,
  options: { failAppend?: () => boolean; tenantScope?: TenantSubjectScopeIndex } = {},
): ResearchTraceStore {
  const tenantScope = options.tenantScope ?? createTenantSubjectScopeIndex();
  return {
    async append(trace) {
      if (options.failAppend?.()) throw new Error("research trace persistence failed");
      tenantScope.bindSubject(trace);
      tenantScope.bindTrace(trace.traceId, trace);
      state.traces.push(structuredClone(sanitizeResearchTrace(trace)));
    },
    async list({ companyId, groupId, limit = 1_000 }) {
      return state.traces
        .filter((trace) => trace.companyId === companyId && trace.groupId === groupId)
        .slice(-Math.max(0, limit))
        .map((trace) => structuredClone(trace));
    },
    async get({ companyId, groupId, traceId }) {
      const trace = state.traces.find((candidate) => candidate.companyId === companyId && candidate.groupId === groupId && candidate.traceId === traceId);
      return trace ? structuredClone(trace) : undefined;
    },
  };
}
