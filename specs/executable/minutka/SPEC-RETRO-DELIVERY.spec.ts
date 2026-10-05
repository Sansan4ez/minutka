import { describe, expect, it, vi } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { InMemoryWorkRetrospectivePolicyStore } from "../../../src/application/work-retrospective-policy.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createRetrospectiveDelivery } from "../../../src/application/retrospective-delivery.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import type { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
const now = "2026-08-26T12:00:00.000Z";
const scope = { employeeId: "e", threadId: "t", companyId: "c", groupId: "g", subjectKey: "s" };
function fixture(world = createInMemoryWorld(() => now)) {
  if (!world.participants.length) {
    world.participants.push({ ...scope, roleId: "r", status: "profile_completed", createdAt: now, updatedAt: now });
    world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Анна", assistantName: "Минутка", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: now, updatedAt: now });
  }
  return createInMemoryRuntime({ world, agentRunner: async () => "unused", assistantAgentRunner: async (_, context) => {
    await context.workRetrospective!.update({ question: { text: "Как проверили?", stage: "actions" } });
    return { text: "Как проверили?", executionTrace: [] };
  }, workRetrospectivePolicies: new InMemoryWorkRetrospectivePolicyStore([{ companyId: "c", groupId: "g", enabled: true, period: { start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" }, methodVersion: "v1" }]) });
}
async function setup() {
  const runtime = fixture();
  await runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: now, updatedAt: now } });
  const result = await runtime.assistantChat!.chat({ userId: "e", threadId: "t", text: "Отчёт" });
  const canonical = createInMemoryConversationStore(runtime.world);
  const episodes = createInMemoryWorkRetrospectiveStore(canonical);
  const budget = async () => {
    const read = await episodes.readEpisodes({ scope, limit: 100 });
    return "value" in read ? read.value[0]!.questionBudget.dailyDelivered : -1;
  };
  const send = vi.fn(async () => ({ messageId: 1 }));
  const shell = (record = runtime.responseDelivery.record) => createTelegramShell({ client: {} as ServiceMinutkaClient,
    sessionStore: runtime.telegramSessionStore, privacyExplanation: "privacy", recordResponseDelivery: record,
    replyPort: { sendMessage: send, editReplyMarkup: async () => undefined, sendChatAction: async () => undefined, answerCallbackQuery: async () => undefined } });
  return { runtime, result, canonical, episodes, budget, send, shell };
}
describe("canonical transport delivery", () => {
  it("SPEC-RETRO-DELIVERY-01 success counts only after shell transport; failure never counts", async () => {
    for (const fails of [false, true]) {
      const f = await setup();
      expect(await f.budget()).toBe(0);
      if (fails) f.send.mockRejectedValue(new Error("transport"));
      const delivery = f.shell().deliverProactive("chat", f.result, "e");
      if (fails) await expect(delivery).rejects.toThrow("transport"); else await delivery;
      expect(await f.budget()).toBe(fails ? 0 : 1);
      expect(f.runtime.world.messages[0]!.metadata!.deliveryEvents![0]!.action).toMatchObject({ status: fails ? "failed" : "delivered" });
    }
  });
  it("SPEC-RETRO-DELIVERY-02 exact replay and restart restore one durable budget", async () => {
    const f = await setup();
    await f.shell().deliverProactive("chat", f.result, "e");
    const restarted = fixture(f.runtime.world);
    expect(await restarted.responseDelivery.record({ employeeId: "e", threadId: "t", messageId: f.result.messageId, status: "delivered" })).toEqual({ status: "replayed" });
    expect(f.runtime.world.messages[0]!.metadata!.deliveryEvents).toHaveLength(1);
    expect(await f.budget()).toBe(1);
  });
  it("SPEC-RETRO-DELIVERY-03 foreign employee/thread/message have no ledger writes or foreign reads", async () => {
    const f = await setup();
    const read = vi.spyOn(f.canonical, "readEvents");
    const recorder = createRetrospectiveDelivery({ canonical: f.canonical, episodes: f.episodes, profiles: createInMemoryProfileStore(f.runtime.world) });
    for (const receipt of [{ employeeId: "foreign", threadId: "t", messageId: f.result.messageId }, { employeeId: "e", threadId: "foreign", messageId: f.result.messageId }, { employeeId: "e", threadId: "t", messageId: "foreign" }]) {
      expect(["not_found", "forbidden"]).toContain((await recorder.record({ ...receipt, status: "delivered" })).status);
    }
    expect(read).not.toHaveBeenCalled();
    expect(f.runtime.world.messages[0]!.metadata!.deliveryEvents).toBeUndefined();
  });
  it("SPEC-RETRO-DELIVERY-04 partial send fails; receipt failure never resends or loses canonical facts", async () => {
    const partial = await setup();
    partial.send.mockResolvedValueOnce({ messageId: 1 }).mockRejectedValueOnce(new Error("second part"));
    await expect(partial.shell().deliverProactive("chat", { ...partial.result, response: "x".repeat(9000) }, "e")).rejects.toThrow();
    expect(await partial.budget()).toBe(0);
    expect(partial.runtime.world.messages[0]!.metadata!.deliveryEvents![0]!.action).toMatchObject({ status: "failed" });
    const f = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recorder = createRetrospectiveDelivery({ canonical: { ...f.canonical, appendDeliveryEvents: async () => { throw new Error("private storage text"); } }, episodes: f.episodes, profiles: createInMemoryProfileStore(f.runtime.world) });
    await f.shell(recorder.record).deliverProactive("chat", f.result, "e");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("response receipt failed"));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private storage text");
    expect(f.runtime.world.messages[0]!.metadata!.retrospectiveEvents).toHaveLength(2);
    log.mockRestore();
  });
  it("SPEC-RETRO-DELIVERY-05 scheduled zero-question receipt is scoped and readable without employee facts", async () => {
    const f = await setup();
    await f.canonical.appendTurn({ ...scope, messageId: "weekly", userText: "scheduled", agentResponse: "summary", timestamp: now, origin: "scheduled", retrospectiveDeliveryScope: scope, scheduledProvenance: { processId: "weekly_summary", scheduleId: "schedule", scheduledFor: now } });
    await f.shell().deliverProactive("chat", { ...f.result, messageId: "weekly", response: "summary" }, "e");
    const deliveries = await f.runtime.responseDelivery.readDeliveries({ scope, localDate: "2026-08-26" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ processId: "weekly_summary", scheduleId: "schedule", scheduledFor: now });
    expect(await f.budget()).toBe(0);
    expect(f.runtime.world.messages).toHaveLength(2);
    expect(f.runtime.world.messages[1]!.metadata!.retrospectiveEvents).toBeUndefined();
  });
});
