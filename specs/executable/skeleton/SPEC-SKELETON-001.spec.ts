import { describe, it, expect } from "vitest";
import {
  createSpecWorld,
  expectEvent,
  registerSpecMetadata,
} from "../support/spec-harness.js";
import { testEmployee } from "../support/fixtures.js";

registerSpecMetadata({
  id: "SPEC-SKELETON-001",
  userStory: "US-SKELETON-001",
  requirements: ["FR-CHAT-001"],
  productParts: ["agent-minutka-brief"],
  contracts: ["chat"],
  events: ["ChatMessageReceived", "ChatResponseGenerated"],
  mastra: ["minutkaAgent"],
  cli: ["employee chat"],
});

describe("SPEC-SKELETON-001: agent responds to text message via CLI", () => {
  it("Mastra agent is registered and importable (smoke)", async () => {
    const { mastra } = await import("../../../src/mastra/index.js");
    const { minutkaAgent } = await import(
      "../../../src/mastra/agents/minutka-agent.js"
    );
    expect(mastra).toBeDefined();
    expect(minutkaAgent).toBeDefined();
    expect(minutkaAgent.name).toBe("Минутка");
  });

  it("accepts employee text and returns agent response", async () => {
    // Mock-runner: спека не зависит от LLM/API-ключа.
    const mockAgentRunner = async () =>
      "Слышу тебя. Давай разберём план на сегодня.";

    const spec = createSpecWorld(mockAgentRunner);

    const result = await spec.cli.json<{
      messageId: string;
      response: string;
    }>([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      "Сегодня у меня три встречи и нужно закрыть отчёт.",
    ]);

    // Проверяем структуру ответа
    expect(result.messageId).toMatch(/^msg_/);
    expect(result.response).toBeTruthy();
    expect(result.response.length).toBeGreaterThan(5);

    // Проверяем, что domain events эмитнулись
    expectEvent(spec, [
      {
        type: "ChatMessageReceived",
        employeeId: testEmployee.employeeId,
      },
      {
        type: "ChatResponseGenerated",
        employeeId: testEmployee.employeeId,
      },
    ]);
  });

  it("rejects empty text", async () => {
    const spec = createSpecWorld(async () => "ok");

    // Пустой текст должен быть отвергнут Zod-валидацией в SDK
    await expect(
      spec.cli.json(["employee", "chat", "--employee", "emp_1", "--text", ""]),
    ).rejects.toThrow();
  });
});
