import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AssistantAgentRunner } from "../../../src/application/assistant-service.js";
import { assertGeneratedContextSourceMinimums } from "../../../src/application/generated-context-startup-validator.js";
import { contextBudgetConfigFromEnv, countUnicodeCharacters } from "../../../src/application/context-budget.js";
import { renderEmptyAssistantContextSection } from "../../../src/application/assistant-context-renderer.js";
import { renderEmptyContextTreeIndex } from "../../../src/application/context-tree-index.js";

const noOpAgent: AssistantAgentRunner = async () => "unused";

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
  it("keeps the documented environment example compatible with startup minimums", () => {
    const exampleEnv: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(".env.example", "utf8").split(/\r?\n/)) {
      const match = /^#? ?(ASSISTANT_(?:CONTEXT|DOCUMENT)_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) exampleEnv[match[1]!] = match[2]!;
    }

    expect(() => assertGeneratedContextSourceMinimums(contextBudgetConfigFromEnv(exampleEnv))).not.toThrow();
  });

  it("rejects a tiny generated-source ceiling before PostgreSQL can connect", async () => {
    const contextMinimum = countUnicodeCharacters(renderEmptyAssistantContextSection());
    const indexMinimum = countUnicodeCharacters(renderEmptyContextTreeIndex(4));
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
    await expect(startup).rejects.not.toThrow(/connect|ECONNREFUSED/u);
  });

  it("accepts exact generated minimums and proceeds to the external-resource boundary", async () => {
    const contextMinimum = countUnicodeCharacters(renderEmptyAssistantContextSection());
    const indexMinimum = countUnicodeCharacters(renderEmptyContextTreeIndex(4));
    const { createPostgresRuntime } = await import("../../../src/runtime/create-postgres-runtime.js");

    const connect = createPostgresRuntime({
      assistantAgentRunner: noOpAgent,
      env: startupEnv({
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: String(contextMinimum),
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_INDEX_CHARACTERS: String(indexMinimum),
      }),
    });

    await expect(connect).rejects.not.toThrow(/minimum rendered representation/u);
  });
});
