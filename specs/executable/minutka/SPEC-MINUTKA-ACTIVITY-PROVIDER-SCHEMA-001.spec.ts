import { Agent } from "@mastra/core/agent";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import type { CollectActivitiesResult } from "../../../src/application/activity-collection.js";
import { extractDurationEvidence, RequestDurationEvidence } from "../../../src/application/activity-duration-evidence.js";
import { collectActivitiesMaximumItems } from "../../../src/contracts/minutka-activity.js";
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
  type?: string | string[];
  enum?: Array<string | null>;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
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
    expect(node.oneOf, `${path} must not use oneOf`).toBeUndefined();
    expect(node.allOf, `${path} must not use allOf`).toBeUndefined();
    expect(node.not, `${path} must not use not`).toBeUndefined();
    if (node.type !== undefined) {
      for (const type of Array.isArray(node.type) ? node.type : [node.type]) {
        expect(type, `${path} must declare only supported JSON types`).toMatch(/^(object|array|string|integer|number|boolean|null)$/);
      }
    } else {
      expect(node.anyOf, `${path} without type must be a union`).toBeDefined();
    }
    if (node.properties) {
      expect(node.required, `${path} strict object properties must all be required`).toEqual(Object.keys(node.properties));
      for (const [name, property] of Object.entries(node.properties)) visit(property, `${path}.properties.${name}`);
    }
    if (node.items) visit(node.items, `${path}.items`);
    if (node.anyOf) {
      for (const [index, variant] of node.anyOf.entries()) visit(variant, `${path}.anyOf.${index}`);
    }
  };
  visit(schema!, "inputSchema");
}

function expectNullableEnum(schema: JsonSchema | undefined, values: readonly string[]): void {
  expect(schema?.enum, "nullable enum must not retain a contradictory sibling enum").toBeUndefined();
  expect(schema?.anyOf).toEqual([
    expect.objectContaining({ type: "string", enum: [...values] }),
    { type: "null" },
  ]);
}

function validateSchema(schema: JsonSchema, payload: unknown): boolean {
  const validator = new Ajv({ strict: true });
  validator.addKeyword({ keyword: "x-optional", schemaType: "array" });
  return validator.compile(schema)(payload) as boolean;
}

function captureModel(calls: Array<{ tools?: ProviderTool[] }>) {
  return {
    specificationVersion: "v2",
    provider: "openai",
    modelId: "gpt-5.5",
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
}

describe("SPEC-MINUTKA-ACTIVITY-PROVIDER-SCHEMA-001: provider request boundary", () => {
  it("carries nullable closed dictionaries and evidence guidance in the actual OpenAI-compatible request", async () => {
    const calls: Array<{ tools?: ProviderTool[] }> = [];
    const collectActivities = async ({ activities }: { activities: unknown[] }): Promise<CollectActivitiesResult> => ({
      status: "completed",
      savedCount: activities.length,
      activityIds: [],
    });
    const agent = new Agent({
      id: "activity-provider-schema",
      name: "activity-provider-schema",
      instructions: "Reply without calling tools.",
      model: captureModel(calls),
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
      type: "array",
      description: expect.stringMatching(new RegExp(`minimum length 1.*maximum length ${collectActivitiesMaximumItems}`, "i")),
    });
    const itemSchema = activityTool?.inputSchema?.properties?.activities?.items;
    const properties = itemSchema?.properties;
    expect(itemSchema?.required).toEqual([
      "taskCategory",
      "routinePattern",
      "automationCandidate",
      "energyStressMarker",
      "system",
      "routineId",
      "routineLabel",
      "recurrence",
      "durationRef",
    ]);
    expectNullableEnum(properties?.taskCategory, taskCategories);
    expectNullableEnum(properties?.routinePattern, routinePatternTypes);
    expectNullableEnum(properties?.automationCandidate, automationCandidateTypes);
    expectNullableEnum(properties?.energyStressMarker, energyStressMarkerTypes);
    expect(properties?.durationBucket).toBeUndefined();
    expectNullableEnum(properties?.durationRef, ["duration_1", "duration_2"]);
    expect(properties?.durationRef?.anyOf?.[0]?.description).toMatch(/request-local.*each ref.*once/i);
    expectNullableEnum(properties?.system, activitySystems);
    expect(properties?.routinePattern?.anyOf?.[0]?.description).toMatch(/explicit.*omit.*other/i);
    expect(properties?.automationCandidate?.anyOf?.[0]?.description).toMatch(/explicit.*omit.*other/i);
    expect(properties?.energyStressMarker?.anyOf?.[0]?.description).toMatch(/explicit.*omit.*neutral.*never a default/i);
    expect(properties?.system?.anyOf?.[0]?.description).toMatch(/explicit.*omit.*other/i);
    expect(activityTool?.description).toMatch(/current employee message.*evidence boundary/i);
    expect(activityTool?.description).toMatch(/validation.*retry.*same agent turn/i);
    expectSupportedResponsesSchema(activityTool?.inputSchema);

    const nullablePayload = {
      taskCategory: "meetings",
      routinePattern: null,
      automationCandidate: null,
      energyStressMarker: null,
      system: null,
      routineId: null,
      routineLabel: null,
      recurrence: null,
      durationRef: null,
    };
    expect(validateSchema(activityTool!.inputSchema!, { activities: [nullablePayload] })).toBe(true);
    expect(validateSchema(activityTool!.inputSchema!, {
      activities: [{ ...nullablePayload, routinePattern: "invented_pattern" }],
    })).toBe(false);
  });

  it("keeps zero-duration collection and correction strict while omitting durationRef", async () => {
    const calls: Array<{ tools?: ProviderTool[] }> = [];
    const evidence = new RequestDurationEvidence([]);
    const agent = new Agent({
      id: "zero-duration-provider-schema",
      name: "zero-duration-provider-schema",
      instructions: "Reply without calling tools.",
      model: captureModel(calls),
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

    const nullableFacets = {
      taskCategory: "meetings",
      routinePattern: null,
      automationCandidate: null,
      energyStressMarker: null,
      system: null,
      routineId: null,
      routineLabel: null,
      recurrence: null,
    };
    expect(validateSchema(collectionSchema!, { activities: [nullableFacets] })).toBe(true);
    expect(validateSchema(correctionSchema!, {
      handle: "activity_recent",
      expectedRevision: 1,
      mode: "patch",
      correction: nullableFacets,
    })).toBe(true);
    expect(validateSchema(collectionSchema!, {
      activities: [{ ...nullableFacets, routinePattern: "invented_pattern" }],
    })).toBe(false);
    expect(validateSchema(correctionSchema!, {
      handle: "activity_recent",
      expectedRevision: 1,
      mode: "patch",
      correction: { ...nullableFacets, system: "invented_system" },
    })).toBe(false);
  });

  it("normalizes provider null sentinels before collection and correction use-cases", async () => {
    const evidence = new RequestDurationEvidence(extractDurationEvidence("Встреча заняла 35 минут."));
    const collectionCalls: unknown[] = [];
    const correctionCalls: unknown[] = [];
    const collectionTool = createCollectActivitiesTool(async (input) => {
      collectionCalls.push(input);
      return { status: "completed", savedCount: input.activities.length, activityIds: ["activity_1"] };
    }, evidence);
    const correctionTool = createCorrectRecentActivityTool(async (input) => {
      correctionCalls.push(input);
      return { status: "completed", handle: input.handle, revision: input.expectedRevision + 1 };
    }, evidence);

    await collectionTool.execute?.({ activities: [{
      taskCategory: "meetings",
      routinePattern: null,
      automationCandidate: null,
      energyStressMarker: null,
      system: null,
      durationRef: null,
    }] } as never, {} as never);
    await correctionTool.execute?.({
      handle: "activity_recent",
      expectedRevision: 1,
      mode: "patch",
      correction: {
        taskCategory: null,
        routinePattern: "waiting_for_input",
        automationCandidate: null,
        energyStressMarker: null,
        system: null,
        durationRef: "duration_1",
      },
    } as never, {} as never);

    expect(collectionCalls).toEqual([{ activities: [{ taskCategory: "meetings" }] }]);
    expect(correctionCalls).toEqual([{
      handle: "activity_recent",
      expectedRevision: 1,
      mode: "patch",
      correction: { routinePattern: "waiting_for_input", durationBucket: "30_60m" },
    }]);
    expect(JSON.stringify({ collectionCalls, correctionCalls })).not.toContain("null");
    expect(JSON.stringify({ collectionCalls, correctionCalls })).not.toContain("durationRef");
  });
});
