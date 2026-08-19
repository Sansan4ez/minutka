import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";
import { createSpecHttpApplication } from "../support/assistant-chat-adapter.js";
import { listenHttpServer, type RunningHttpServer } from "../../../src/server/http/http-server.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";

const employeeAToken = "a".repeat(64);
const employeeBToken = "b".repeat(64);
const serviceToken = "s".repeat(64);
const running: RunningHttpServer[] = [];
afterEach(async () => Promise.all(running.splice(0).map((server) => server.close())));

async function ready() {
  const runtime = createInMemoryRuntime({ agentRunner: async () => "ok", deps: createDefaultSpecDeps() });
  for (const [employeeId, inviteCode, profile] of [
    ["employee_a", "invite_a", { preferredName: "Анна", persona: "support", responseLength: "balanced", timezone: "Europe/Moscow", selfDescription: "Координирую тендеры", typicalTasks: ["Подготовка заявок"], aiLevel: "intermediate", programGoal: "Сократить ручную проверку" }],
    ["employee_b", "invite_b", { preferredName: "Борис", persona: "efficiency", responseLength: "short", timezone: "Asia/Yekaterinburg", selfDescription: "Веду логистику" }],
  ] as const) {
    await runtime.service.issueInvite({ employeeId, inviteCode, companyId: "default_company", groupId: "default_group" });
    await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
    const { typicalTasks, ...profileFields } = profile;
    await runtime.service.completeOnboarding({ employeeId, roleId: "default_role", ...profileFields, ...(typicalTasks ? { typicalTasks: [...typicalTasks] } : {}) });
  }
  const server = await listenHttpServer({
    application: createSpecHttpApplication(runtime.service), port: 0, logger: () => undefined,
    auth: { serviceToken, employeeTokens: new Map([["employee_a", employeeAToken], ["employee_b", employeeBToken]]) },
  });
  running.push(server);
  return { runtime, server };
}

async function request(url: string, path: string, token: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
}

describe("SPEC-MINUTKA-PERSONAL-CONTEXT-REVIEW-001: narrow owner context review", () => {
  it("shows only the authenticated employee's allow-listed profile and separates observations", async () => {
    const { server } = await ready();
    const response = await request(server.url, "/v1/me/context", employeeAToken);
    expect(response.status).toBe(200);
    const context = await response.json();

    expect(context).toMatchObject({
      confirmedProfile: {
        preferredName: "Анна", persona: "support", responseLength: "balanced", timezone: "Europe/Moscow",
        exactRole: "Участник", selfDescription: "Координирую тендеры", typicalTasks: ["Подготовка заявок"],
        aiLevel: "intermediate", programGoal: "Сократить ручную проверку",
      },
      observations: { status: "none_confirmed", items: [] },
    });
    expect(context.editableFields).toEqual(["preferredName", "persona", "responseLength", "timezone", "role", "typicalTasks", "aiLevel", "programGoal"]);
    expect(JSON.stringify(context)).not.toMatch(/employee_a|employee_b|default_company|default_group|default_role|subject|telegram|thread|message|trace/u);
    expect(JSON.stringify(context)).not.toContain("Борис");
  });

  it("patches only allow-listed fields for the bearer owner and rejects target injection", async () => {
    const { runtime, server } = await ready();
    const patched = await request(server.url, "/v1/me/context", employeeAToken, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferredName: "Анна-Мария", responseLength: "short", timezone: "Europe/Kaliningrad", role: "Точно описываю тендерный процесс", typicalTasks: ["Проверка заявок"] }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      changedFields: ["preferredName", "responseLength", "timezone", "role", "typicalTasks"],
      context: { confirmedProfile: { preferredName: "Анна-Мария", responseLength: "short", timezone: "Europe/Kaliningrad", exactRole: "Участник", selfDescription: "Точно описываю тендерный процесс", typicalTasks: ["Проверка заявок"] } },
    });
    expect((await runtime.service.getProfile({ employeeId: "employee_b" })).preferredName).toBe("Борис");

    const injected = await request(server.url, "/v1/me/context", employeeAToken, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "employee_b", preferredName: "Украдено" }),
    });
    expect(injected.status).toBe(400);
    expect((await runtime.service.getProfile({ employeeId: "employee_b" })).preferredName).toBe("Борис");
    expect((await runtime.service.getProfile({ employeeId: "employee_a" })).roleId).toBe("default_role");
  });

  it("renders the deterministic Telegram /context view without ids or raw history", async () => {
    const { runtime } = await ready();
    const identity = { chatId: "chat-a", userId: "telegram-a" };
    await runtime.telegramSessionStore.claim({ identity, session: { employeeId: "employee_a", threadId: "thread-a", createdAt: runtime.world.now(), updatedAt: runtime.world.now() } });
    await runtime.telegramSessionStore.markConsentAccepted({ identity, employeeId: "employee_a", acceptedAt: runtime.world.now() });
    const messages: string[] = [];
    const client = new ServiceMinutkaClient({
      async redeemTelegramInvite() { throw new Error("not used"); },
      forEmployee(employeeId: string) {
        return {
          async getProfile() { return runtime.service.getProfile({ employeeId }); },
          async getPersonalContext() { return runtime.service.getPersonalContext({ employeeId }); },
        } as never;
      },
    });
    const shell = createTelegramShell({
      client, sessionStore: runtime.telegramSessionStore, privacyExplanation: "privacy",
      replyPort: { async sendMessage(_chatId, text) { messages.push(text); return { messageId: messages.length }; }, async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {} },
    });

    await shell.handleContext("chat-a", "telegram-a");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Ваш подтверждённый профиль:");
    expect(messages[0]).toContain("должность: Участник");
    expect(messages[0]).toContain("Осторожные наблюдения:");
    expect(messages[0]).not.toMatch(/employee_a|default_company|default_group|default_role|thread-a|telegram-a/u);
  });
});
