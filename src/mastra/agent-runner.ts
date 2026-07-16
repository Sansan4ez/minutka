import type { AssistantAgentRunner } from "../application/assistant-service.js";
import { createCaptureIdeaTool } from "./tools/capture-idea-tool.js";
import { assistantDocumentToolNames, createDocumentTools } from "./tools/document-tools.js";

export const assistantRuntimeToolsets = {
  inbox: ["captureIdea"],
  documents: assistantDocumentToolNames,
} as const;

export const assistantActiveToolNames = [
  ...assistantRuntimeToolsets.inbox,
  ...assistantRuntimeToolsets.documents,
] as const;

export type MastraAgentLike = {
  generate(
    text: string,
    options: { system?: string; toolChoice?: "auto" | "none"; maxSteps?: number; toolsets?: Record<string, Record<string, unknown>>; activeTools?: string[] },
  ): Promise<{ text?: string }>;
};

/** Runtime bridge for the personal assistant; only request-scoped typed tools are enabled. */
export function createAssistantAgentRunner(agent: MastraAgentLike): AssistantAgentRunner {
  return async (input, context) => {
    const result = await agent.generate(input.text, {
      system: context.systemContext,
      toolChoice: "auto",
      toolsets: {
        inbox: { captureIdea: createCaptureIdeaTool(context.captureIdea) },
        documents: createDocumentTools(context.documents),
      },
      // `activeTools` is applied after all toolsets are resolved, so ambient
      // agent-level tools cannot be selected during the personal assistant run.
      activeTools: [...assistantActiveToolNames],
      maxSteps: 4,
    });
    return result.text ?? "";
  };
}
