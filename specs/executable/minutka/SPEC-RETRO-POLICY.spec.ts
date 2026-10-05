import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkRetrospectivePolicyStore, resolveWorkRetrospectivePolicy } from "../../../src/application/work-retrospective-policy.js";
import { WorkRetrospectivePolicyManagement } from "../../../src/application/work-retrospective-policy-management.js";
import { runWorkRetrospectivePolicyCommand } from "../../../src/runtime/work-retrospective-policy-command.js";
import { createWorkRetrospectiveService } from "../../../src/application/work-retrospective-service.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import type { WorkRetrospectiveEpisode, WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";
const now = "2026-10-05T12:00:00.000Z";
const scope = { companyId: "c1", groupId: "g1" };
const enable = { ...scope, action: "enable" as const, start: "2026-10-05T00:00:00+03:00", end: "2026-10-19T00:00:00+03:00", methodVersion: "v1" };
function fixture() {
  const store = new InMemoryWorkRetrospectivePolicyStore();
  const write = vi.spyOn(store, "write");
  const service = new WorkRetrospectivePolicyManagement(store, { groupBelongsToCompany: async s => s.companyId === "c1" }, { now: () => now });
  return { store, write, service };
}
describe("operator retrospective policy", () => {
  it("SPEC-RETRO-POLICY-01 missing policies default disabled", async () => {
    const { store } = fixture();
    expect(await resolveWorkRetrospectivePolicy(store, scope, now)).toEqual({ enabled: false });
    expect(await store.read({ ...scope, groupId: "g2" })).toBeUndefined();
  });
  it("SPEC-RETRO-POLICY-02 preview/wrong confirmation perform zero writes", async () => {
    const { service, write } = fixture();
    expect(await service.preview(enable)).toMatchObject({ policy: { ...scope, enabled: true, period: { start: enable.start, end: enable.end }, methodVersion: "v1" } });
    await expect(service.confirm(enable, "yes")).rejects.toThrow("confirmation mismatch");
    expect(write).not.toHaveBeenCalled();
  });
  it("SPEC-RETRO-POLICY-03 exact confirmation enables only requested group", async () => {
    const { service, store } = fixture();
    await service.confirm(enable, "ENABLE RETROSPECTIVE c1/g1");
    expect(await resolveWorkRetrospectivePolicy(store, scope, now)).toMatchObject({ enabled: true });
    expect(await store.read({ ...scope, groupId: "g2" })).toBeUndefined();
  });
  it("SPEC-RETRO-POLICY-04 disable-enable hides canonical pending and rejects stale mutation, preserves facts/step", async () => {
    const { service: management, store: policies } = fixture();
    await management.confirm(enable, "ENABLE RETROSPECTIVE c1/g1");
    const owner = { ...scope, employeeId: "e1", subjectKey: "00000000-0000-4000-8000-000000000001", threadId: "t1" };
    const world = createInMemoryWorld(() => now);
    world.participants.push({ ...owner, status: "profile_completed", createdAt: now, updatedAt: now });
    const conversations = createInMemoryConversationStore(world);
    const store = createInMemoryWorkRetrospectiveStore(conversations);
    const episode: WorkRetrospectiveEpisode = { ...owner, episodeId: "ep1", period: { start: "2026-10-05T00:00:00Z", end: "2026-10-19T00:00:00Z" }, methodVersion: "v1", messageRefs: [{ messageId: "m1" }], activityRefs: [{ activityId: "a1", revision: 1 }], statements: { actions: [], value: [], future: [], indicators: [] }, selectedStep: { statementId: "step", text: "test", kind: "intention", sourceRefs: [{ type: "message", messageId: "m1" }] }, status: "active", revision: 0, questionBudget: { localDate: "2026-10-05", dailyDelivered: 0 } };
    const base = { ...owner, episodeId: "ep1", sourceMessageId: "m1", version: 1 as const, timestamp: "2026-10-05T11:00:00Z" };
    const events: WorkRetrospectiveEvent[] = [{ ...base, eventId: "ev1", ordinal: 0, expectedRevision: 0, action: { type: "episode_selected", episode } }, { ...base, eventId: "ev2", ordinal: 1, expectedRevision: 1, action: { type: "question_generated", question: { questionId: "q1", text: "test?", sourceTurn: { messageId: "m1" }, target: { episodeId: "ep1", revision: 1, stage: "actions", sourceRefs: [{ type: "message", messageId: "m1" }] } } } }];
    const retrospective = createWorkRetrospectiveService(store, conversations, policies);
    expect(await retrospective.applyTurn({ scope: owner, episodeId: "ep1", expectedRevision: 0, events }, { ...owner, messageId: "m1", timestamp: base.timestamp, userText: "fact", agentResponse: "test?" })).toMatchObject({ status: "applied" });
    await management.confirm({ ...scope, action: "disable" }, "DISABLE RETROSPECTIVE c1/g1");
    await management.confirm(enable, "ENABLE RETROSPECTIVE c1/g1");
    const result = await retrospective.readEpisode({ scope: owner, episodeId: "ep1" });
    expect(result).toMatchObject({ value: { activityRefs: episode.activityRefs, selectedStep: episode.selectedStep } });
    if ("value" in result) expect(result.value.pendingQuestion).toBeUndefined();
    expect(await retrospective.applyTurn({ scope: owner, episodeId: "ep1", expectedRevision: 2, events: [{ ...base, sourceMessageId: "m2", eventId: "ev3", ordinal: 0, expectedRevision: 2, timestamp: now, action: { type: "question_closed", questionId: "q1", reason: "answered" } }] }, { ...owner, messageId: "m2", timestamp: now, userText: "да", agentResponse: "ok" })).toEqual({ status: "stale" });
  });
  it("SPEC-RETRO-POLICY-05 invalid scope/period rejected without writes", async () => {
    const { service, write } = fixture();
    for (const input of [{ ...enable, companyId: "c2" }, { ...enable, end: enable.start }, { ...enable, start: "2026-10-05" }]) await expect(service.preview(input)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("SPEC-RETRO-POLICY-06 purge is company/group scoped", async () => {
    const { store, service } = fixture();
    await service.confirm(enable, "ENABLE RETROSPECTIVE c1/g1");
    const policy = (await store.read(scope))!;
    await store.write({ ...policy, groupId: "g2" });
    await store.write({ ...policy, companyId: "c2", groupId: "g3" });
    expect(await store.purge(scope)).toBe(1);
    expect(await store.purge({ companyId: "c1" })).toBe(1);
    expect(await store.read({ companyId: "c2", groupId: "g3" })).toBeDefined();
  });
  it("CLI preview and wrong/exact confirmation preserve no-send and cleanup", async () => {
    const { service, write } = fixture();
    const close = vi.fn(async () => {});
    const readConfirmation = vi.fn(async () => "wrong");
    const output: string[] = [];
    const factory = async () => ({ service, close, readConfirmation, write: (text: string) => { output.push(text); } });
    const args = ["enable", "--company", "c1", "--group", "g1", "--start", enable.start, "--end", enable.end, "--method-version", "v1"];
    expect(await runWorkRetrospectivePolicyCommand([...args, "--preview"], factory, () => {})).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(readConfirmation).not.toHaveBeenCalled();
    expect(await runWorkRetrospectivePolicyCommand(args, factory, () => {})).toBe(1);
    expect(write).not.toHaveBeenCalled();
    readConfirmation.mockResolvedValue("ENABLE RETROSPECTIVE c1/g1");
    expect(await runWorkRetrospectivePolicyCommand(args, factory, () => {})).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(3);
    expect(output.join("")).toContain(enable.start);
  });
  it("SPEC-RETRO-POLICY-07 help and invalid args never initialize DB", async () => {
    const factory = vi.fn();
    expect(await runWorkRetrospectivePolicyCommand(["--help"], factory, () => {})).toBe(0);
    expect(await runWorkRetrospectivePolicyCommand(["enable", "--company", "c1", "--group", "g1"], factory, () => {})).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.MIGRATION_DATABASE_URL;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/runtime/work-retrospective-policy.ts", "--help"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--method-version");
    expect(result.stderr).toBe("");
  });
});
