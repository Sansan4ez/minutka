import { Agent } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import type { CollectActivitiesResult } from "../../../src/application/activity-collection.js";
import { collectActivitiesMaximumItems } from "../../../src/contracts/minutka-activity.js";
import { extractDurationEvidence, RequestDurationEvidence } from "../../../src/application/activity-duration-evidence.js";
import {
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../../../src/domain/insights.js";
import { createCollectActivitiesTool } from "../../../src/mastra/tools/activity-collection-tool.js";
import { createCorrectRecentActivityTool } from "../../../src/mastra/tools/activity-correction-tools.js";

type JsonSchema = {
  type?: string;
  enum?: string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
  not?: unknown;
};
type ProviderTool = {
  type: "function";
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

function expectSupportedResponsesSchema(schema: JsonSchema | undefined): void {
  expect(schema).toBeDefined();
  const visit = (node: JsonSchema, path: string) => {
    expect(node.anyOf, `${path} must not use anyOf`).toBeUndefined();
    expect(node.oneOf, `${path} must not use oneOf`).toBeUndefined();
    expect(node.allOf, `${path} must not use allOf`).toBeUndefined();
    expect(node.not, `${path} must not use not`).toBeUndefined();
    expect(node.type, `${path} must declare a supported JSON type`).toMatch(/^(object|array|string|integer|number|boolean|null)$/);
    if (node.properties) {
      for (const [name, property] of Object.entries(node.properties)) visit(property, `${path}.properties.${name}`);
    }
    if (node.items) visit(node.items, `${path}.items`);
  };
  visit(schema!, "inputSchema");
}

describe("SPEC-MINUTKA-ACTIVITY-PROVIDER-SCHEMA-001: provider request boundary", () => {
  it("carries closed dictionaries and evidence guidance in the actual Mastra model request", async () => {
    const calls: Array<{ tools?: ProviderTool[] }> = [];
    const model = {
      specificationVersion: "v2",
      provider: "request-capture",
      modelId: "request-capture",
      supportedUrls: {},
      async doGenerate(options: { tools?: ProviderTool[] }) {
        calls.push(options);
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text", text: "ok" }],
          warnings: [],
        };
      },
      async doStream() { throw new Error("streaming is not used in this spec"); },
    } as never;
    const collectActivities = async ({ activities }: { activities: unknown[] }): Promise<CollectActivitiesResult> => ({
      status: "completed",
      savedCount: activities.length,
      activityIds: [],
    });
    const agent = new Agent({
      id: "activity-provider-schema",
      name: "activity-provider-schema",
      instructions: "Reply without calling tools.",
      model,
      tools: {},
      editor: false,
    });

    await agent.generate("schema check", {
      toolsets: { activities: { collectActivities: createCollectActivitiesTool(
        collectActivities as never,
        new RequestDurationEvidence(extractDurationEvidence("Встреча заняла 35 минут, отчёт — 2 часа.")),
      ) } },
      activeTools: ["collectActivities"],
      toolChoice: "auto",
      maxSteps: 1,
    });

    const activityTool = calls[0]?.tools?.find((tool) => tool.name === "collectActivities");
    expect(activityTool?.inputSchema?.properties?.activities).toMatchObject({
      minItems: 1,
      maxItems: collectActivitiesMaximumItems,
    });
    const properties = activityTool?.inputSchema?.properties?.activities?.items?.properties;
    expect(properties?.taskCategory?.enum).toEqual([...taskCategories]);
    expect(properties?.routinePattern?.enum).toEqual([...routinePatternTypes]);
    expect(properties?.automationCandidate?.enum).toEqual([...automationCandidateTypes]);
    expect(properties?.energyStressMarker?.enum).toEqual([...energyStressMarkerTypes]);
    expect(properties?.durationBucket).toBeUndefined();
    expect(properties?.durationRef?.enum).toEqual(["duration_1", "duration_2"]);
    expect(properties?.durationRef?.description).toMatch(/request-local.*each ref.*once/i);
    expect(properties?.system?.enum).toEqual([...activitySystems]);
    expect(properties?.routinePattern?.description).toMatch(/explicit.*omit.*other/i);
    expect(properties?.automationCandidate?.description).toMatch(/explicit.*omit.*other/i);
    expect(properties?.energyStressMarker?.description).toMatch(/explicit.*omit.*neutral.*never a default/i);
    expect(properties?.system?.description).toMatch(/explicit.*omit.*other/i);
    expect(activityTool?.description).toMatch(/current employee message.*evidence boundary/i);
    expect(activityTool?.description).toMatch(/validation.*retry.*same agent turn/i);
  });

  it("omits unsupported durationRef from the actual zero-candidate collection and correction schemas", async () => {
    const calls: Array<{ tools?: ProviderTool[] }> = [];
    const model = {
      specificationVersion: "v2",
      provider: "request-capture",
      modelId: "request-capture",
      supportedUrls: {},
      async doGenerate(options: { tools?: ProviderTool[] }) {
        calls.push(options);
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text", text: "ok" }],
          warnings: [],
        };
      },
      async doStream() { throw new Error("streaming is not used in this spec"); },
    } as never;
    const evidence = new RequestDurationEvidence([]);
    const agent = new Agent({
      id: "zero-duration-provider-schema",
      name: "zero-duration-provider-schema",
      instructions: "Reply without calling tools.",
      model,
      tools: {},
      editor: false,
    });

    await agent.generate("schema check", {
      toolsets: { activities: {
        collectActivities: createCollectActivitiesTool(
          async ({ activities }) => ({ status: "completed", savedCount: activities.length, activityIds: [] }),
          evidence,
        ),
        correctRecentActivity: createCorrectRecentActivityTool(
          async ({ handle, expectedRevision }) => ({ status: "completed", handle, revision: expectedRevision + 1 }),
          evidence,
        ),
      } },
      activeTools: ["collectActivities", "correctRecentActivity"],
      toolChoice: "auto",
      maxSteps: 1,
    });

    const collectionSchema = calls[0]?.tools?.find((tool) => tool.name === "collectActivities")?.inputSchema;
    const correctionSchema = calls[0]?.tools?.find((tool) => tool.name === "correctRecentActivity")?.inputSchema;
    expect(collectionSchema?.properties?.activities?.items?.properties?.durationRef).toBeUndefined();
    expect(correctionSchema?.properties?.correction?.properties?.durationRef).toBeUndefined();
    expectSupportedResponsesSchema(collectionSchema);
    expectSupportedResponsesSchema(correctionSchema);
  });
});
