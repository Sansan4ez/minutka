import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyContextBudget,
  assertContextSourceContentFits,
  contextBudgetConfigFromEnv,
  contextWrapperMarkupAllowance,
  countUnicodeCharacters,
  createContextBudgetConfig,
  defaultContextBudget,
  guaranteedContextSourceIds,
  minimumContextBudgetTotal,
  sourceCharacterCeiling,
} from "../../../src/application/context-budget.js";
import { assistantContextLimits } from "../../../src/application/assistant-context-projection.js";
import { renderEmptyAssistantContextSection } from "../../../src/application/assistant-context-renderer.js";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import { renderAssistantAgentManual } from "../../../src/application/assistant-static-context.js";
import { renderMaximumResponsePolicy } from "../../../src/domain/response-policy.js";
import { renderEmptyContextTreeIndex } from "../../../src/application/context-tree-index.js";
import { assertGeneratedContextSourceMinimums, generatedContextSourceMinimums } from "../../../src/application/generated-context-startup-validator.js";
import { assistantRecordsLimits } from "../../../src/application/assistant-records-projection.js";
import { buildAssistantSystemContext } from "../../../src/application/assistant-service.js";
import { conversationContextLimits } from "../../../src/application/conversation-context-limits.js";
import { documentReadLimits } from "../../../src/application/document-reader.js";
import { runtimeProjectionLimits } from "../../../src/application/runtime-projections/runtime-projection-limits.js";
import { minimumRecentHistoryCharacters, renderThreadSummaryProjection } from "../../../src/application/runtime-projections/runtime-projection-renderer.js";
import { canonicalThreadSummaryWatermark, minimumThreadSummaryText } from "../../../src/application/thread-summarizer.js";
import { maxChatInputCharacters } from "../../../src/shared/chat-limits.js";

/**
 * `agent_manual` is the largest static context source and is resent on every LLM
 * step of every owner turn, so its size is a recurring cost rather than a
 * formatting detail.
 *
 * The runtime already refuses to start when the manual overflows its ceiling
 * (`assertGeneratedContextSourceMinimums`), but that check runs inside
 * `createPostgresRuntime` — a deploy-time failure for whoever last edited
 * `vault/assistant`. Pinning the measured size moves the same failure into
 * `npm run verify` and makes any growth deliberate.
 *
 * Measured 2026-08-15 after adding the morning activity collection process and
 * typed action: 26 793 of 29 000 characters. Later role/process updates reduced
 * that manual and repinned it. The current increase includes the consent
 * retention disclosure required by mnt-pilot-readiness-w73.30 and the bounded
 * reminder/escalation disclosure required by mnt-cycle-completion-4gd.2 and
 * the narrow personal-context review required by mnt-cycle-completion-4gd.7.
 * The weekly checkpoint required by mnt-cycle-completion-4gd.3 adds a sixth
 * active process; its ceiling moved from 33 000 to 34 000 so the manual keeps
 * the same headroom, while the guaranteed ceilings still fit the total budget.
 * The final personal report required by mnt-cycle-completion-4gd.4 adds a
 * seventh active process; its ceiling moved from 34 000 to 35 000 on the same
 * terms. mnt-pilot-readiness-w73.36 then moved the ceiling to 45 000 and the
 * total to 110 000 at once, because per-process 1 000 steps had left only 409
 * characters before a fail-closed production start; the guaranteed ceilings now
 * sum to 81 000 inside the total budget. mnt-unbounded-activity-capture-yc3.2
 * repins the manual after making factual activity collection a cross-process,
 * any-time rule and documenting batch collection plus evening deduplication.
 * mnt-unbounded-activity-capture-yc3.6 repins the explicit handling of failed
 * and partial collection results. mnt-unbounded-activity-capture-yc3.7 repins
 * today's morning factual writes and the final-report exception.
 */
const pinnedAgentManualCharacters = 36_440;

/**
 * The startup check fails closed: a manual above its ceiling stops the service
 * from coming up at all instead of degrading it. So the ceiling has to hold not
 * just today's manual but every edit made between two deploys.
 *
 * At 34 591 worst-case characters the previous 35 000 ceiling left 409 — any
 * noticeable `vault/assistant` edit stopped a running pilot production instance
 * (mnt-pilot-readiness-w73.36, reproduced 2026-08-19). The 45 000 ceiling keeps
 * roughly a third of the manual free, which is about ten more processes at the
 * ~1 000 characters each of the last seven. This threshold fails `npm run
 * verify` while that headroom is still thousands of characters, so a growing
 * manual is a budget decision here rather than a production restart failure.
 */
const minimumAgentManualHeadroomCharacters = 8_000;

const projection = {
  schemaVersion: 1 as const,
  path: "/proc/context" as const,
  generatedAt: "2026-07-17T00:00:00.000Z",
  scope: { userId: "owner", requestId: "request" },
  data: {
    documents: [],
    truncated: false,
    index: { level: "files" as const, documentCount: 0, text: "## Machine index: /proc/context\n(empty)" },
  },
};

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-BUDGET-001: unified request context budget", () => {
  it("keeps the documented defaults as the single source for legacy limit exports", () => {
    expect(defaultContextBudget.total).toBe(110_000);
    expect(defaultContextBudget.sources.map(({ id }) => id)).toEqual([
      "base_instructions", "agent_manual", "profile", "context", "context_index", "records", "inbox", "thread_summary", "history", "actions",
    ]);
    expect(assistantContextLimits).toEqual({ documents: 12, characters: 24_000, documentCharacters: 8_000, indexCharacters: 6_000, indexDepth: 4 });
    expect(assistantRecordsLimits).toEqual({ records: 24, characters: 12_000, recordCharacters: 1_000 });
    expect(conversationContextLimits).toMatchObject({ responseTurns: 10, responseCharacters: 12_000, responseFieldCharacters: 6_000 });
    expect(runtimeProjectionLimits).toMatchObject({ threadTurns: 10, threadCharacters: 12_000, threadTurnTextCharacters: 6_000, threadSummaryCharacters: 4_000 });
    expect(defaultContextBudget.projectionLimits).toMatchObject({ threadCompactionTurns: 10, threadCompactionFieldCharacters: 2_000 });
    expect(documentReadLimits).toEqual({
      listDefault: 20, listMaximum: 50, readDefaultCharacters: 4_000, readMaximumCharacters: 8_000,
      turnReadCharacters: 48_000, maximumDocumentBytes: 256 * 1024, turnScanBytes: 2 * 1024 * 1024,
      searchDefault: 10, searchMaximum: 20, searchSnippetCharacters: 500,
    });
  });

  it("counts Unicode code points and reserves input plus response space at the boundary", () => {
    expect(countUnicodeCharacters("🙂a")).toBe(2);
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + contextWrapperMarkupAllowance + 36,
      responseReserve: 2,
      sources: { base_instructions: 1, agent_manual: 3, profile: 10, context: 10, context_index: 10, records: 10, inbox: 10, history: minimumRecentHistoryCharacters, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const exact = applyContextBudget({
      config,
      userInput: "🙂".repeat(maxChatInputCharacters),
      sections: [
        { sourceId: "base_instructions", content: "A" },
        { sourceId: "agent_manual", content: "🙂🙂🙂" },
      ],
    });
    expect(exact.text).toBe("A\n\n🙂🙂🙂");
    expect(exact.used).toBe(6);
    expect(exact.available).toBe(34);
    expect(exact.contextSourceCharacters).toEqual({ base_instructions: 1, agent_manual: 3 });
    expect(() => applyContextBudget({ ...exactInput(config), userInput: "🙂".repeat(maxChatInputCharacters + 1) })).toThrow("exceeds the 4096-character maximum");
  });

  it("never lets lower-priority owner data displace trusted control-plane content", () => {
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + contextWrapperMarkupAllowance + 43,
      responseReserve: 0,
      sources: { base_instructions: 0, agent_manual: 7, profile: 12, context: 12, context_index: 12, records: 12, inbox: 12, history: minimumRecentHistoryCharacters, actions: 12 },
      projectionLimits: { contextDocumentCharacters: 12, recordCharacters: 12, historyTurnCharacters: 12 },
    });
    const result = applyContextBudget({
      config,
      userInput: "x".repeat(maxChatInputCharacters),
      sections: [
        { sourceId: "records", content: "records" },
        { sourceId: "agent_manual", content: "trusted" },
        { sourceId: "context", content: "owner" },
      ],
    });
    expect(result.text).toBe("trusted\n\nowner\n\nrecords");
    expect(result.omittedSourceIds).toEqual([]);
  });

  it("omits every lower-priority section after the first owner section overflows", () => {
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + contextWrapperMarkupAllowance + 30,
      responseReserve: 0,
      sources: { base_instructions: 0, agent_manual: 0, profile: 10, context: 10, context_index: 10, records: 10, inbox: 10, history: minimumRecentHistoryCharacters, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const result = applyContextBudget({
      config,
      userInput: "x".repeat(maxChatInputCharacters),
      sections: [
        { sourceId: "context", content: "owner" },
        { sourceId: "records", content: "records" },
        { sourceId: "history", content: "h" },
      ],
    });
    expect(result.text).toBe("owner\n\nrecords\n\nh");
    expect(result.used).toBe(17);
    expect(result.omittedSourceIds).toEqual([]);
  });

  it("applies the aggregate budget at the buildAssistantSystemContext seam", () => {
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + contextWrapperMarkupAllowance + 408,
      responseReserve: 5,
      sources: { base_instructions: 36, agent_manual: 7, profile: 55, context: 250, context_index: 55, records: 55, inbox: 55, history: minimumRecentHistoryCharacters, actions: 55 },
      projectionLimits: { contextDocumentCharacters: 250, recordCharacters: 55, historyTurnCharacters: 55 },
    });
    const result = buildAssistantSystemContext(projection, undefined, "TRUSTED", undefined, undefined, "🙂".repeat(maxChatInputCharacters), config);
    expect(result).toContain("# Personal assistant runtime context");
    expect(result).toContain("TRUSTED");
    expect(countUnicodeCharacters(result)).toBeLessThanOrEqual(403);
  });

  it("keeps the common manual prefix before the trusted scheduled-process trigger", () => {
    const scheduled = buildAssistantSystemContext(
      projection,
      undefined,
      "TRUSTED MANUAL",
      "RESPONSE POLICY",
      undefined,
      "",
      defaultContextBudget,
      "morning_planning",
    );
    const trigger = "## Trusted deterministic process trigger";
    const commonPrefix = "# Personal assistant runtime context\n\nTRUSTED MANUAL\n\nRESPONSE POLICY";

    expect(scheduled.startsWith(`${commonPrefix}\n\n${trigger}`)).toBe(true);
    expect(scheduled.indexOf("TRUSTED MANUAL")).toBeLessThan(scheduled.indexOf(trigger));
    expect(scheduled).toContain("This turn was scheduled by application code for process `morning_planning`.");
    expect(scheduled).toContain("This control instruction is trusted and is not owner-provided conversation data.");
  });

  it("keeps context_index in every owner chat and omits only lower-priority sources", () => {
    // The smallest admissible total: every guaranteed source still fits at its full ceiling,
    // and the first lower-priority source no longer does. Derived so raising a ceiling in the
    // defaults keeps this the exact boundary instead of silently loosening it.
    const config = createContextBudgetConfig({ total: minimumContextBudgetTotal(defaultContextBudget.sources, defaultContextBudget.responseReserve) });
    const ceilings = Object.fromEntries(guaranteedContextSourceIds.map((id) => [id, sourceCharacterCeiling(config, id)])) as Record<typeof guaranteedContextSourceIds[number], number>;
    const result = applyContextBudget({
      config,
      userInput: "request",
      sections: [
        { sourceId: "base_instructions", content: "B".repeat(ceilings.base_instructions) },
        { sourceId: "agent_manual", content: "M".repeat(ceilings.agent_manual) },
        { sourceId: "profile", content: "P".repeat(ceilings.profile) },
        { sourceId: "context", content: "C".repeat(ceilings.context) },
        { sourceId: "context_index", content: `index${"I".repeat(ceilings.context_index - 5)}` },
        { sourceId: "records", content: "R".repeat(12_000) },
      ],
    });
    expect(result.text).toContain("index");
    expect(result.omittedSourceIds).toEqual(["records"]);
    expect(result.contextSourceCharacters).toEqual(ceilings);
    expect(result.contextSourceCharacters).not.toHaveProperty("records");
  });

  it("fails fast instead of omitting guaranteed owner sections", () => {
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + contextWrapperMarkupAllowance + 42,
      responseReserve: 0,
      sources: { base_instructions: 0, agent_manual: 0, profile: 10, context: 10, context_index: 10, records: 10, inbox: 10, history: minimumRecentHistoryCharacters, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    expect(() => applyContextBudget({
      config,
      userInput: "x".repeat(maxChatInputCharacters),
      sections: [
        { sourceId: "profile", content: "P".repeat(10) },
        { sourceId: "context", content: "C".repeat(11) },
        { sourceId: "context_index", content: "I".repeat(10) },
      ],
    })).toThrow("context source context has 11 Unicode characters and exceeds its 10-character rendered source ceiling");
  });

  it("rejects every non-empty source above its own rendered ceiling", () => {
    const config = createContextBudgetConfig();
    expect(() => applyContextBudget({
      config,
      userInput: "request",
      sections: [{ sourceId: "records", content: "R".repeat(12_001) }],
    })).toThrow("context source records has 12001 Unicode characters and exceeds its 12000-character rendered source ceiling");
  });

  it("rejects context budgets that cannot hold trusted ceilings at maximum input", () => {
    expect(() => createContextBudgetConfig({
      total: 10_000,
      responseReserve: 1_000,
      sources: { base_instructions: 2_000, agent_manual: 3_000, profile: 4_000, context: 10_000, context_index: 6_000, records: 10_000, history: 10_000 },
      projectionLimits: { contextDocumentCharacters: 10_000, recordCharacters: 10_000, historyTurnCharacters: 10_000 },
    })).toThrow("guaranteed context ceilings (25000) plus maximum user input (4096), response reserve (1000), and wrapper markup allowance (2000) must not exceed total budget (10000)");
  });

  it("fails fast when loaded trusted content exceeds its configured ceiling", () => {
    const config = createContextBudgetConfig({
      total: 22_000,
      responseReserve: 1_000,
      sources: { base_instructions: 1_000, agent_manual: 3_000, profile: 0, context: 10_000, context_index: 0, records: 10_000, history: 10_000 },
      projectionLimits: { contextDocumentCharacters: 10_000, recordCharacters: 10_000, historyTurnCharacters: 10_000 },
    });
    expect(() => assertContextSourceContentFits({
      config,
      sourceId: "agent_manual",
      content: "🙂".repeat(3_001),
      label: "loaded assistant agent manual",
    })).toThrow("loaded assistant agent manual has 3001 Unicode characters and exceeds the 3000-character agent_manual ceiling");
  });

  it("keeps active deployment-example overrides compatible with the canonical budget", () => {
    const exampleEnv: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(".env.example", "utf8").split(/\r?\n/)) {
      const match = /^(ASSISTANT_(?:CONTEXT|DOCUMENT)_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) exampleEnv[match[1]!] = match[2]!;
    }

    const config = contextBudgetConfigFromEnv(exampleEnv);
    expect(() => assertContextSourceContentFits({
      config,
      sourceId: "agent_manual",
      content: loadAssistantAgentInstructions(),
      label: "loaded assistant agent manual",
    })).not.toThrow();
  });

  it("rejects history ceilings below the production-rendered minimum and accepts the exact boundary", () => {
    expect(minimumRecentHistoryCharacters).toBeGreaterThan(0);
    expect(() => createContextBudgetConfig({
      sources: { history: minimumRecentHistoryCharacters - 1 },
      projectionLimits: { historyTurnCharacters: 1 },
    })).toThrow(`context source history ceiling must be at least ${minimumRecentHistoryCharacters} Unicode characters`);
    expect(sourceCharacterCeiling(createContextBudgetConfig({
      sources: { history: minimumRecentHistoryCharacters },
      projectionLimits: { historyTurnCharacters: 1 },
    }), "history")).toBe(minimumRecentHistoryCharacters);
  });

  it("parses environment overrides and fails fast on invalid or contradictory values", () => {
    expect(contextBudgetConfigFromEnv({
      ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "90000",
      ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS: "9000",
      ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: "17000",
      ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: "5000",
      ASSISTANT_CONTEXT_THREAD_COMPACTION_TURNS: "8",
      ASSISTANT_CONTEXT_THREAD_COMPACTION_FIELD_CHARACTERS: "1500",
      ASSISTANT_DOCUMENT_READ_MAXIMUM_CHARACTERS: "9000",
      ASSISTANT_DOCUMENT_TURN_READ_CHARACTERS: "49000",
      ASSISTANT_DOCUMENT_MAXIMUM_BYTES: "300000",
      ASSISTANT_DOCUMENT_TURN_SCAN_BYTES: "3000000",
    })).toMatchObject({
      total: 90_000,
      responseReserve: 9_000,
      projectionLimits: { contextDocumentCharacters: 5_000, threadCompactionTurns: 8, threadCompactionFieldCharacters: 1_500 },
      documentTools: { readMaximumCharacters: 9_000, turnReadCharacters: 49_000, maximumDocumentBytes: 300_000, turnScanBytes: 3_000_000 },
    });
    expect(() => contextBudgetConfigFromEnv({ ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "-1" })).toThrow("non-negative integer");
    expect(() => contextBudgetConfigFromEnv({ ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "1000" })).toThrow("must not exceed total budget");
    expect(() => createContextBudgetConfig({ sources: { missing: 1 } as never })).toThrow("unknown context budget source");
  });

  it("validates minimum viable generated sections from the production renderers", () => {
    const agentInstructions = loadAssistantAgentInstructions();
    const contextMinimum = countUnicodeCharacters(renderEmptyAssistantContextSection());
    const indexMinimum = countUnicodeCharacters(renderEmptyContextTreeIndex(defaultContextBudget.projectionLimits.contextIndexDepth));
    const summaryMinimum = countUnicodeCharacters(renderThreadSummaryProjection({
      summary: {
        employeeId: "owner", threadId: "thread", text: minimumThreadSummaryText,
        watermark: canonicalThreadSummaryWatermark, updatedAt: "1970-01-01T00:00:00.000Z",
      },
      turns: [], truncated: false,
    }));
    const exact = createContextBudgetConfig({
      sources: { context: contextMinimum, context_index: indexMinimum },
      projectionLimits: { contextDocumentCharacters: contextMinimum },
    });

    expect(() => assertGeneratedContextSourceMinimums(exact, agentInstructions)).not.toThrow();
    expect(() => assertGeneratedContextSourceMinimums(createContextBudgetConfig({
      sources: { context: contextMinimum - 1 },
      projectionLimits: { contextDocumentCharacters: contextMinimum - 1 },
    }), agentInstructions)).toThrow(`context source context requires a minimum rendered representation of ${contextMinimum} Unicode characters, but its configured ceiling is ${contextMinimum - 1}`);
    expect(() => assertGeneratedContextSourceMinimums(createContextBudgetConfig({
      sources: { context_index: indexMinimum - 1 },
    }), agentInstructions)).toThrow(`context source context_index requires a minimum rendered representation of ${indexMinimum} Unicode characters, but its configured ceiling is ${indexMinimum - 1}`);
    expect(() => assertGeneratedContextSourceMinimums(createContextBudgetConfig({
      sources: { base_instructions: 1 },
    }), agentInstructions)).toThrow(/context source base_instructions requires a minimum rendered representation of \d+ Unicode characters, but its configured ceiling is 1/u);
    expect(summaryMinimum).toBeLessThanOrEqual(defaultContextBudget.projectionLimits.threadSummaryCharacters);
    expect(() => assertGeneratedContextSourceMinimums(defaultContextBudget, agentInstructions)).not.toThrow();
  });

  it("keeps thousands of characters between the worst-case manual and its fail-closed ceiling", () => {
    const minimums = generatedContextSourceMinimums(defaultContextBudget, loadAssistantAgentInstructions());
    const worstCase = minimums.find(({ sourceId }) => sourceId === "agent_manual")?.minimum ?? 0;
    const ceiling = sourceCharacterCeiling(defaultContextBudget, "agent_manual");
    const measured = `worst-case rendered agent_manual is ${worstCase} characters; ceiling ${ceiling}; headroom ${ceiling - worstCase}`;

    // The worst case is the scheduled-trigger render, which is larger than the chat render pinned below.
    expect(worstCase, measured).toBeGreaterThanOrEqual(pinnedAgentManualCharacters);
    expect(ceiling - worstCase, `${measured}. Raise the ceiling and the total budget together: see docs/architecture/runtime-context-contract.md.`)
      .toBeGreaterThanOrEqual(minimumAgentManualHeadroomCharacters);
  });

  it("keeps the rendered agent manual inside its ceiling and pins deliberate growth", () => {
    const used = countUnicodeCharacters(renderAssistantAgentManual(loadAssistantAgentInstructions(), renderMaximumResponsePolicy()));
    const ceiling = sourceCharacterCeiling(defaultContextBudget, "agent_manual");
    const measured = `rendered agent_manual is ${used} characters; ceiling ${ceiling}; pinned ${pinnedAgentManualCharacters}; headroom ${ceiling - used}`;

    expect(pinnedAgentManualCharacters, measured).toBeLessThanOrEqual(ceiling);
    expect(used, measured).toBeLessThanOrEqual(ceiling);
    expect(used, `${measured}. Growing the manual is a cost decision, not a formatting detail: see prs-7ohk before repinning.`)
      .toBeLessThanOrEqual(pinnedAgentManualCharacters);
    expect(pinnedAgentManualCharacters, measured).toBeLessThanOrEqual(used);
  });
});

function exactInput(config: ReturnType<typeof createContextBudgetConfig>) {
  return { config, userInput: "", sections: [{ sourceId: "agent_manual" as const, content: "x" }] };
}
