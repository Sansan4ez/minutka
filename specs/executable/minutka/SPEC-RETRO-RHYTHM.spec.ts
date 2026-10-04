import { describe, expect, it } from "vitest";
import { createRetrospectiveTouchPolicy, retrospectiveLocalDate, type RetrospectiveTouchDelivery } from "../../../src/application/retrospective-touch-policy.js";
import { InMemoryWorkRetrospectivePolicyStore } from "../../../src/application/work-retrospective-policy.js";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { SchedulerService, type ScheduledActionFire } from "../../../src/application/scheduler-service.js";
import type { WorkRetrospectiveEpisode } from "../../../src/domain/work-retrospective.js";

const scope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a", subjectKey: "subject_a", threadId: "thread_a" };
function fixture(enabled = true, timezone = "Etc/UTC") {
  let now = "2026-08-28T15:00:00.000Z";
  const clock = { now: () => now };
  const deliveries: RetrospectiveTouchDelivery[] = [];
  const episodes: WorkRetrospectiveEpisode[] = [];
  const calls: ScheduledActionFire[] = [];
  let fail = false;
  const policy = createRetrospectiveTouchPolicy({
    policies: new InMemoryWorkRetrospectivePolicyStore([{ companyId: scope.companyId, groupId: scope.groupId, enabled, methodVersion: "v1", period: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" } }]),
    episodes: { readEpisodes: async () => ({ status: "applied", value: episodes }) },
    resolveOwner: async () => ({ scope, timezone }), readDeliveries: async () => deliveries, now: clock.now,
  });
  const store = createInMemoryScheduleStore(clock);
  const runner = async (fire: ScheduledActionFire) => {
    calls.push(fire);
    if (fail) throw new Error("Telegram failed");
    if (fire.kind !== "process" || fire.processId === "morning_planning") return;
    if (fire.processId !== "evening_reflection" && fire.processId !== "weekly_summary" && fire.processId !== "final_report") return;
    // Transport-success stub emits the canonical delivery evidence, not generation.
    deliveries.push({ processId: fire.processId, scheduleId: fire.scheduleId, scheduledFor: fire.scheduledFor,
      event: { ...scope, eventId: fire.scheduleId, episodeId: "episode", sourceMessageId: fire.scheduleId, ordinal: 0, version: 1, expectedRevision: 0, timestamp: now,
        action: { type: "response_delivery", responseMessageId: fire.scheduleId, status: "delivered", localDate: retrospectiveLocalDate(now, timezone) } } });
  };
  const scheduler = new SchedulerService(store, clock, runner, () => undefined, policy);
  return { calls, deliveries, episodes, policy, store, scheduler,
    setNow: (value: string) => { now = value; }, setFail: (value: boolean) => { fail = value; },
    save: (id: string, processId: string, hour: string, enabled = true) => scheduler.saveDailySchedule(scope.employeeId, { id, processId, timeOfDay: `${hour}:00`, timezone, enabled }),
  };
}

describe("delivery-aware retrospective rhythm", () => {
  it.each(["weekly_summary", "final_report"])("SPEC-RETRO-RHYTHM-01 %s success replaces evening and replay does not deliver twice", async (processId) => {
    const f = fixture();
    await f.save("weekly", processId, "17"); await f.save("evening", "evening_reflection", "19");
    f.setNow("2026-08-28T17:00:00.000Z"); await f.scheduler.tick();
    expect(await f.policy(f.calls[0]!)).toEqual({ action: "suppress", reason: "already_delivered" });
    f.setNow("2026-08-28T19:00:00.000Z"); await f.scheduler.tick(); await f.scheduler.tick();
    expect(f.calls).toHaveLength(1); expect(f.deliveries).toHaveLength(1);
    expect((await f.store.get(scope.employeeId, "evening"))?.enabled).toBe(true);
  });
  it("SPEC-RETRO-RHYTHM-02 failed or disabled weekly leaves evening available", async () => {
    for (const disabled of [false, true]) {
      const f = fixture(); await f.save("weekly", "weekly_summary", "17", !disabled); await f.save("evening", "evening_reflection", "19");
      f.setFail(true); f.setNow("2026-08-28T17:00:00.000Z"); await f.scheduler.tick();
      expect(f.deliveries).toHaveLength(0);
      f.setFail(false); f.setNow("2026-08-28T19:00:00.000Z"); await f.scheduler.tick();
      expect(f.calls.at(-1)?.retrospectiveTouch?.mode).toBe("invite");
    }
  });
  it("SPEC-RETRO-RHYTHM-03 moved evening and later weekly share daily context", async () => {
    const f = fixture(); await f.save("evening", "evening_reflection", "16"); await f.save("weekly", "weekly_summary", "17");
    f.setNow("2026-08-28T16:00:00.000Z"); await f.scheduler.tick();
    f.setNow("2026-08-28T17:00:00.000Z"); await f.scheduler.tick();
    expect(f.calls.map((fire) => fire.retrospectiveTouch?.mode)).toEqual(["invite", "continue"]);
    expect(f.calls[1]?.retrospectiveTouch?.localDate).toBe(f.calls[0]?.retrospectiveTouch?.localDate);
    expect(f.calls[1]?.retrospectiveTouch?.episodeId).toBe("episode");
  });
  it("SPEC-RETRO-RHYTHM-04 preserves active question and uses owner Tokyo date", async () => {
    const f = fixture(true, "Asia/Tokyo");
    f.episodes.push({ ...scope, episodeId: "active", status: "active", pendingQuestion: { questionId: "pending" } } as WorkRetrospectiveEpisode);
    await f.save("evening", "evening_reflection", "02");
    f.setNow("2026-08-28T17:00:00.000Z"); await f.scheduler.tick();
    expect(f.calls[0]?.retrospectiveTouch).toEqual({ mode: "continue", localDate: "2026-08-29", episodeId: "active", preservePendingQuestion: true });
    f.deliveries[0]!.event.groupId = "other";
    f.episodes.length = 0;
    expect(await f.policy({ ...f.calls[0]!, scheduleId: "other" })).toMatchObject({ context: { mode: "invite" } });
  });
  it("SPEC-RETRO-RHYTHM-05 off group retains old schedule policy and morning never suppressed", async () => {
    for (const enabled of [false, true]) {
      const f = fixture(enabled); await f.save("weekly", "weekly_summary", "17"); await f.save("evening", "evening_reflection", "19"); await f.save("morning", "morning_planning", "18");
      for (const hour of ["17", "18", "19"]) { f.setNow(`2026-08-28T${hour}:00:00.000Z`); await f.scheduler.tick(); }
      expect(f.calls.some((fire) => fire.kind === "process" && fire.processId === "morning_planning" && !fire.retrospectiveTouch)).toBe(true);
      expect(f.calls).toHaveLength(enabled ? 2 : 3);
      expect(await f.store.list(scope.employeeId)).toHaveLength(3);
    }
  });
});
