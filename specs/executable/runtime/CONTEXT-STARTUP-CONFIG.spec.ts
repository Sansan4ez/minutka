import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantAgentRunner } from "../../../src/application/assistant-service.js";
import { assertGeneratedContextSourceMinimums } from "../../../src/application/generated-context-startup-validator.js";
import { contextBudgetConfigFromEnv, countUnicodeCharacters } from "../../../src/application/context-budget.js";
import { renderEmptyAssistantContextSection } from "../../../src/application/assistant-context-renderer.js";
import { renderEmptyContextTreeIndex } from "../../../src/application/context-tree-index.js";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import { renderAssistantAgentManual, renderAssistantBaseInstructions } from "../../../src/application/assistant-static-context.js";
import { renderMaximumResponsePolicy } from "../../../src/domain/response-policy.js";
import * as postgresPoolModule from "../../../src/infrastructure/postgres/postgres-pool.js";
import { taskMutationCompletedReplayRetentionEnvName, taskMutationCompletedReplayRetentionFromEnv } from "../../../src/config/task-confirmation-retention.js";
import { defaultUsageCostPolicy, usageCostPolicyFromEnv, usageInputPriceEnvName, usageMonthlySoftLimitEnvName, usageOutputPriceEnvName } from "../../../src/config/usage.js";

const noOpAgent: AssistantAgentRunner = async () => ({ text: "unused", executionTrace: [] });

afterEach(() => vi.restoreAllMocks());

function startupEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:1/personal_assistant",
    DATABASE_SSL_MODE: "disable",
    DATABASE_CONNECT_TIMEOUT_MS: "1",
    INVITE_CODE_PEPPER: "invite-pepper",
    TELEGRAM_IDENTITY_PEPPER: "telegram-pepper",
    PRIVACY_POLICY_V2_URL: "https://example.com/privacy-v2.md",
    ...overrides,
  };
}

describe("CONTEXT-STARTUP-CONFIG: generated context minimums", () => {
  it("requires the configurable completed replay window to exceed confirmation TTL", () => {
    expect(taskMutationCompletedReplayRetentionFromEnv({})).toBe(7 * 24 * 60 * 60_000);
    expect(() => taskMutationCompletedReplayRetentionFromEnv({ [taskMutationCompletedReplayRetentionEnvName]: String(15 * 60_000) })).toThrow("must exceed the task confirmation TTL");
    expect(taskMutationCompletedReplayRetentionFromEnv({ [taskMutationCompletedReplayRetentionEnvName]: String(24 * 60 * 60_000) })).toBe(24 * 60 * 60_000);
  });

  it("parses monthly usage soft-limit and pricing before opening runtime resources", () => {
    expect(usageCostPolicyFromEnv({})).toEqual(defaultUsageCostPolicy);
    expect(usageCostPolicyFromEnv({
      [usageMonthlySoftLimitEnvName]: "12.5",
      [usageInputPriceEnvName]: "1.25",
      [usageOutputPriceEnvName]: "7",
    })).toEqual({
      monthlySoftLimitUsdMicros: 12_500_000,
      inputUsdMicrosPerMillionTokens: 1_250_000,
      outputUsdMicrosPerMillionTokens: 7_000_000,
    });
    expect(() => usageCostPolicyFromEnv({ [usageMonthlySoftLimitEnvName]: "0" })).toThrow("positive safe USD amount");
    expect(() => usageCostPolicyFromEnv({ [usageInputPriceEnvName]: "1.0000001" })).toThrow("up to 6 decimal places");
  });

  function expectNoPostgresPool(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(postgresPoolModule, "createPostgresPool");
  }

  it("keeps the documented environment example compatible with startup minimums", () => {
    const exampleEnv: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(".env.example", "utf8").split(/\r?\n/)) {
      const match = /^#? ?(ASSISTANT_(?:CONTEXT|DOCUMENT)_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) exampleEnv[match[1]!] = match[2]!;
    }

    expect(() => assertGeneratedContextSourceMinimums(
      contextBudgetConfigFromEnv(exampleEnv),
      loadAssistantAgentInstructions(),
    )).not.toThrow();
  });

  it("rejects a base-instructions ceiling below the exact production section before opening PostgreSQL", async () => {
    const baseMinimum = countUnicodeCharacters(renderAssistantBaseInstructions("evening_reflection"));
    const createPool = expectNoPostgresPool();
    const { createPostgresRuntime } = await import("../../../src/runtime/create-postgres-runtime.js");

    await expect(createPostgresRuntime({
      assistantAgentRunner: noOpAgent,
      env: startupEnv({ ASSISTANT_CONTEXT_SOURCE_BASE_INSTRUCTIONS_CHARACTERS: String(baseMinimum - 1) }),
    })).rejects.toThrow(`context source base_instructions requires a minimum rendered representation of ${baseMinimum} Unicode characters, but its configured ceiling is ${baseMinimum - 1}`);
    expect(createPool).not.toHaveBeenCalled();
  });

  it("rejects a manual ceiling that holds the manual but not its worst-case response policy before opening PostgreSQL", async () => {
    const manual = loadAssistantAgentInstructions();
    const manualCharacters = countUnicodeCharacters(manual);
    const renderedMinimum = countUnicodeCharacters(renderAssistantAgentManual(manual, renderMaximumResponsePolicy()));
    const createPool = expectNoPostgresPool();
    const { createPostgresRuntime } = await import("../../../src/runtime/create-postgres-runtime.js");

    expect(renderedMinimum).toBeGreaterThan(manualCharacters);
    await expect(createPostgresRuntime({
      assistantAgentRunner: noOpAgent,
      env: startupEnv({ ASSISTANT_CONTEXT_SOURCE_AGENT_MANUAL_CHARACTERS: String(manualCharacters) }),
    })).rejects.toThrow(`context source agent_manual requires a minimum rendered representation of ${renderedMinimum} Unicode characters, but its configured ceiling is ${manualCharacters}`);
    expect(createPool).not.toHaveBeenCalled();
  });

  it("rejects a tiny generated-source ceiling before PostgreSQL can connect", async () => {
    const contextMinimum = countUnicodeCharacters(renderEmptyAssistantContextSection());
    const indexMinimum = countUnicodeCharacters(renderEmptyContextTreeIndex(4));
    const createPool = expectNoPostgresPool();
    const { createPostgresRuntime } = await import("../../../src/runtime/create-postgres-runtime.js");

    const startup = createPostgresRuntime({
      assistantAgentRunner: noOpAgent,
      env: startupEnv({
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_INDEX_CHARACTERS: String(indexMinimum - 1),
      }),
    });

    await expect(startup).rejects.toThrow(`context source context_index requires a minimum rendered representation of ${indexMinimum} Unicode characters, but its configured ceiling is ${indexMinimum - 1}`);
    expect(createPool).not.toHaveBeenCalled();
  });

  it("accepts exact static and generated minimums and proceeds to the external-resource boundary", async () => {
    const baseMinimum = countUnicodeCharacters(renderAssistantBaseInstructions("evening_reflection"));
    const manualMinimum = countUnicodeCharacters(renderAssistantAgentManual(loadAssistantAgentInstructions(), renderMaximumResponsePolicy()));
    const contextMinimum = countUnicodeCharacters(renderEmptyAssistantContextSection());
    const indexMinimum = countUnicodeCharacters(renderEmptyContextTreeIndex(4));
    const { createPostgresRuntime } = await import("../../../src/runtime/create-postgres-runtime.js");

    const connect = createPostgresRuntime({
      assistantAgentRunner: noOpAgent,
      env: startupEnv({
        ASSISTANT_CONTEXT_SOURCE_BASE_INSTRUCTIONS_CHARACTERS: String(baseMinimum),
        ASSISTANT_CONTEXT_SOURCE_AGENT_MANUAL_CHARACTERS: String(manualMinimum),
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_INDEX_CHARACTERS: String(indexMinimum),
      }),
    });

    await expect(connect).rejects.not.toThrow(/minimum rendered representation/u);
  });
});
