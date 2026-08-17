import { describe, expect, it } from "vitest";
import type { AssistantAgentContext } from "../../../src/application/assistant-service.js";
import { assistantActiveToolNames, createAssistantToolsets } from "../../../src/mastra/agent-runner.js";

const allowedUnionFields = new Set<string>();

function createStubContext(): AssistantAgentContext {
  const callableStub = async () => ({});
  const capabilities = new Proxy({}, { get: () => callableStub });
  const documents = new Proxy({
    limits: {
      searchSnippetCharacters: 1_000,
      listMaximum: 50,
      readMaximumCharacters: 10_000,
      searchMaximum: 50,
    },
  }, {
    get: (target, property) => property === "limits" ? target.limits : callableStub,
  });

  return {
    systemContext: "",
    personalContext: {} as AssistantAgentContext["personalContext"],
    profileAndHistory: {} as AssistantAgentContext["profileAndHistory"],
    records: {} as AssistantAgentContext["records"],
    source: { kind: "text", text: "schema guard" },
    captureIdea: callableStub,
    documents: documents as AssistantAgentContext["documents"],
    contextDocuments: capabilities as AssistantAgentContext["contextDocuments"],
    tasks: capabilities as AssistantAgentContext["tasks"],
    ideas: capabilities as AssistantAgentContext["ideas"],
    projects: capabilities as AssistantAgentContext["projects"],
    schedules: capabilities as AssistantAgentContext["schedules"],
    collectActivity: (async () => ({ activityId: "activity" })) as AssistantAgentContext["collectActivity"],
    markProcessUsed() {},
  } as unknown as AssistantAgentContext;
}

function unionPaths(schema: unknown, keyword: "anyOf" | "oneOf"): string[] {
  const paths: string[] = [];

  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path);
      return;
    }
    if (!node || typeof node !== "object") return;

    const object = node as Record<string, unknown>;
    if (keyword in object) paths.push(path || "<root>");
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [property, propertySchema] of Object.entries(value as Record<string, unknown>)) {
          visit(propertySchema, path ? `${path}.${property}` : property);
        }
      } else if (key === "items") {
        visit(value, `${path}[]`);
      } else {
        visit(value, path);
      }
    }
  };

  visit(schema, "");
  return paths;
}

describe("SPEC-PERSONAL-ASSISTANT-TOOL-SCHEMA-SHAPE-001: registered provider schemas", () => {
  it("keeps toolsets and activeTools in exact sync", () => {
    const toolsets = createAssistantToolsets(createStubContext());
    const registeredNames = Object.values(toolsets).flatMap((toolset) => Object.keys(toolset));

    expect(registeredNames).toEqual([...assistantActiveToolNames]);
  });

  it("keeps every input rule inside the schema the provider shows the model", () => {
    // A cross-field check sits on the object itself and never reaches JSON
    // Schema, so the model cannot see the rule, cannot satisfy it, and retries
    // the rejected call until the step ceiling — the turn then ends with no
    // text at all. Field-level checks are fine: they do serialize.
    for (const tool of Object.values(createAssistantToolsets(createStubContext())).flatMap((toolset) => Object.values(toolset))) {
      const objectChecks = (tool.inputSchema as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks ?? [];
      expect(objectChecks, `${tool.id} enforces an input rule its provider schema cannot express`).toEqual([]);
    }
  });

  it("forbids allOf and requires an explicit allow-list for every union field", () => {
    const toolsets = createAssistantToolsets(createStubContext());
    const seenUnionFields = new Set<string>();

    for (const tool of Object.values(toolsets).flatMap((toolset) => Object.values(toolset))) {
      const schema = tool.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
      expect(JSON.stringify(schema), `${tool.id} must not expose allOf`).not.toContain('"allOf"');

      for (const keyword of ["anyOf", "oneOf"] as const) {
        for (const path of unionPaths(schema, keyword)) {
          const field = `${tool.id}.${path}`;
          expect(allowedUnionFields.has(field), `${field} uses ${keyword} without an explicit allow-list decision`).toBe(true);
          seenUnionFields.add(field);
        }
      }
    }

    expect([...seenUnionFields].sort()).toEqual([...allowedUnionFields].sort());
  });
});
