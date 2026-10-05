import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryTenantDirectoryStore } from "../../../src/application/in-memory-tenant-directory-store.js";
import { createDirectoryWorkRetrospectivePolicyStore, resolveWorkRetrospectivePolicy, workRetrospectiveMethodVersion } from "../../../src/application/work-retrospective-policy.js";

const scope = { employeeId: "employee", companyId: "company", groupId: "group", subjectKey: "subject" };
function fixture(timezone = "Europe/Berlin", period = { start: "2026-03-28", end: "2026-03-29" }) {
  let now = "2026-03-29T12:00:00.000Z";
  const world = createInMemoryWorld(() => now);
  world.participants.push({ ...scope, roleId: "role", status: "profile_completed", createdAt: now, updatedAt: now });
  world.profiles.push({ ...scope, roleId: "role", preferredName: "Анна", assistantName: "Минутка", addressForm: "formal", persona: "support", responseLength: "short", timezone, createdAt: now, updatedAt: now });
  world.tenantDirectories.groups.push({ id: scope.groupId, companyId: scope.companyId, period });
  const profiles = createInMemoryProfileStore(world);
  const directory = createInMemoryTenantDirectoryStore(world.tenantDirectories);
  return { world, profiles, directory, policies: createDirectoryWorkRetrospectivePolicyStore({ profiles, directory }), setNow(value: string) { now = value; } };
}
describe("directory-derived retrospective availability", () => {
  it("SPEC-RETRO-AVAILABILITY-01 default runtime persists directory episode without policy seeds", async () => {
    const f = fixture();
    const runtime = createInMemoryRuntime({ world: f.world, agentRunner: async () => "unused", assistantAgentRunner: async (_, context) => {
      expect(context.workRetrospective).toBeDefined();
      expect(await context.workRetrospective!.update({ question: { text: "Как проверили отчёт?", stage: "actions" } })).toMatchObject({ status: "staged" });
      return { text: "Как проверили отчёт?", executionTrace: [] };
    } });
    await runtime.assistantChat!.chat({ userId: scope.employeeId, threadId: "thread", text: "Сделал отчёт" });
    const action = f.world.messages[0]?.metadata?.retrospectiveEvents?.[0]?.action;
    expect(action?.type).toBe("episode_selected");
    if (action?.type === "episode_selected") expect(action.episode).toMatchObject({ period: { start: "2026-03-27T23:00:00.000Z", end: "2026-03-29T22:00:00.000Z" }, methodVersion: workRetrospectiveMethodVersion });
  });
  it("SPEC-RETRO-AVAILABILITY-02 foreign/missing scope or process has no availability; factual path remains", async () => {
    const f = fixture();
    for (const request of [{ ...scope, companyId: "foreign" }, { ...scope, groupId: "foreign" }, { ...scope, subjectKey: "foreign" }]) expect(await f.policies.read(request)).toBeUndefined();
    expect(await createDirectoryWorkRetrospectivePolicyStore({ ...f, processIds: [] }).read(scope)).toBeUndefined();
    f.world.tenantDirectories.groups.find((group) => group.id === scope.groupId)!.period = undefined;
    let facts = 0;
    const runtime = createInMemoryRuntime({ world: f.world, agentRunner: async () => "unused", assistantDeps: { processCurrentActivityTurn: async () => { facts++; return { status: "completed", operation: "collect", savedCount: 1, activityIds: ["a"], extraction: { context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } } }; } }, assistantAgentRunner: async (_, context) => {
      expect(context.workRetrospective).toBeUndefined();
      await context.processCurrentActivityTurn({ mode: "record" });
      return { text: "Принято", executionTrace: [] };
    } });
    await runtime.assistantChat!.chat({ userId: scope.employeeId, threadId: "thread", text: "Отчёт" });
    expect(facts).toBe(1);
    expect(f.world.messages[0]?.metadata?.retrospectiveEvents).toBeUndefined();
  });
  it("SPEC-RETRO-AVAILABILITY-03 inclusive local dates and exclusive end across DST/Tokyo", async () => {
    for (const [timezone, start, end] of [["Europe/Berlin", "2026-03-27T23:00:00.000Z", "2026-03-29T22:00:00.000Z"], ["Asia/Tokyo", "2026-03-27T15:00:00.000Z", "2026-03-29T15:00:00.000Z"]]) {
      const f = fixture(timezone);
      expect(await f.policies.availability(scope)).toMatchObject({ localPeriod: { start: "2026-03-28", end: "2026-03-29" }, period: { start, end } });
      expect((await resolveWorkRetrospectivePolicy(f.policies, scope, start!)).enabled).toBe(true);
      expect((await resolveWorkRetrospectivePolicy(f.policies, scope, new Date(Date.parse(end!) - 1).toISOString())).enabled).toBe(true);
      expect((await resolveWorkRetrospectivePolicy(f.policies, scope, end!)).enabled).toBe(false);
    }
  });
  it("SPEC-RETRO-AVAILABILITY-04 completed cycle closes pending but preserves historical context", async () => {
    const f = fixture();
    const runtime = createInMemoryRuntime({ world: f.world, agentRunner: async () => "unused", assistantAgentRunner: async (_, context) => {
      if (f.world.messages.length === 0) {
        await context.workRetrospective!.update({ question: { text: "Как проверили?", stage: "actions" } });
        return { text: "Как проверили?", executionTrace: [] };
      }
      const historical = JSON.parse(await context.workRetrospective!.read());
      expect(historical.active.episodeId).toBeDefined();
      expect(historical.active.question).toBeUndefined();
      expect(await context.workRetrospective!.update({ question: { text: "Ещё?", stage: "actions" } })).toMatchObject({ status: "forbidden" });
      return { text: "Итог доступен", executionTrace: [] };
    } });
    await runtime.assistantChat!.chat({ userId: scope.employeeId, threadId: "thread", text: "Отчёт" });
    f.setNow("2026-03-29T22:00:00.000Z");
    await runtime.assistantChat!.chat({ userId: scope.employeeId, threadId: "thread", text: "Итог" });
    expect(f.world.messages).toHaveLength(2);
    expect(f.world.messages[1]?.metadata?.retrospectiveEvents?.[0]?.action).toMatchObject({ type: "question_closed", reason: "cycle_ended" });
  });
  it("SPEC-RETRO-AVAILABILITY-05 both composition roots derive rather than seed default policies", () => {
    for (const file of ["create-in-memory-runtime.ts", "create-postgres-runtime.ts"]) {
      const source = readFileSync(`src/runtime/${file}`, "utf8");
      expect(source).toContain("input.workRetrospectivePolicies ?? createDirectoryWorkRetrospectivePolicyStore");
      expect(source).not.toContain("new InMemoryWorkRetrospectivePolicyStore");
    }
  });
});
