import { Agent } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import type { CollectActivitiesResult } from "../../../src/application/activity-collection.js";
import { collectActivitiesMaximumItems } from "../../../src/contracts/minutka-activity.js";
import { createCollectActivitiesTool } from "../../../src/mastra/tools/activity-collection-tool.js";

type ProviderTool = {
  type: "function";
  name: string;
  inputSchema?: {
    properties?: { activities?: { minItems?: number; maxItems?: number } };
  };
};

describe("SPEC-MINUTKA-ACTIVITY-PROVIDER-SCHEMA-001: provider request boundary", () => {
  it("carries the activity batch limit in the actual Mastra model request", async () => {
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
      toolsets: { activities: { collectActivities: createCollectActivitiesTool(collectActivities as never) } },
      activeTools: ["collectActivities"],
      toolChoice: "auto",
      maxSteps: 1,
    });

    const activityTool = calls[0]?.tools?.find((tool) => tool.name === "collectActivities");
    expect(activityTool?.inputSchema?.properties?.activities).toMatchObject({
      minItems: 1,
      maxItems: collectActivitiesMaximumItems,
    });
  });
});
