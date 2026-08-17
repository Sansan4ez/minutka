import type { AssistantChatResult } from "../application/assistant-service.js";
import type { ParticipantPage } from "../application/minutka-service.js";
import type { PersonalAssistantService } from "../application/personal-assistant-service.js";
import {
  isAssistantScheduledProcessId,
  type AssistantScheduledProcessId,
} from "../domain/assistant-process.js";
import { loadDotEnv } from "../config/env.js";

export type ScheduledProcessRunArguments = {
  employeeId: string;
  processId: AssistantScheduledProcessId;
  threadId: string;
};

type ScheduledProcessApplication = Pick<PersonalAssistantService, "listParticipants" | "runScheduledProcess">;

export function parseScheduledProcessRunArguments(args: string[]): ScheduledProcessRunArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1]?.trim();
    if (!option || !["--employee", "--process", "--thread"].includes(option) || !value || values.has(option)) {
      throw usageError();
    }
    values.set(option, value);
  }

  const employeeId = values.get("--employee");
  const processId = values.get("--process");
  if (!employeeId || !processId) throw usageError();
  if (!isAssistantScheduledProcessId(processId)) {
    throw new Error(`unsupported scheduled process: ${processId}`);
  }
  return {
    employeeId,
    processId,
    threadId: values.get("--thread") ?? "default",
  };
}

export async function runScheduledProcessOnDemand(
  application: ScheduledProcessApplication,
  input: ScheduledProcessRunArguments,
): Promise<AssistantChatResult> {
  const participant = await findParticipant(application, input.employeeId);
  if (!participant) throw new Error(`employee ${JSON.stringify(input.employeeId)} was not found`);
  if (participant.status !== "profile_completed") {
    throw new Error(
      `employee ${JSON.stringify(input.employeeId)} has not completed onboarding (status: ${participant.status})`,
    );
  }
  return application.runScheduledProcess({
    userId: input.employeeId,
    threadId: input.threadId,
    processId: input.processId,
  });
}

async function findParticipant(
  application: Pick<PersonalAssistantService, "listParticipants">,
  employeeId: string,
): Promise<ParticipantPage["participants"][number] | undefined> {
  let after: string | undefined;
  do {
    const page = await application.listParticipants({ limit: 100, ...(after ? { after } : {}) });
    const participant = page.participants.find((candidate) => candidate.employeeId === employeeId);
    if (participant) return participant;
    after = page.nextCursor;
  } while (after);
  return undefined;
}

async function main(): Promise<void> {
  const input = parseScheduledProcessRunArguments(process.argv.slice(2));
  loadDotEnv();
  const [runtimeModule, runnerModule, agentModule] = await Promise.all([
    import("./create-postgres-runtime.js"),
    import("../mastra/agent-runner.js"),
    import("../mastra/agents/personal-assistant-agent.js"),
  ]);
  const runtime = await runtimeModule.createPostgresRuntime({
    assistantAgentRunner: runnerModule.createAssistantAgentRunner(agentModule.personalAssistantAgent),
    env: process.env,
  });
  try {
    const result = await runScheduledProcessOnDemand(runtime.assistant, input);
    process.stdout.write(`${result.response}\n`);
  } finally {
    await runtime.shutdown();
  }
}

function usageError(): Error {
  return new Error(
    "usage: npm run process:run -- --employee <employee_id> --process <process_id> [--thread <thread_id>]",
  );
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "scheduled process run failed");
    process.exitCode = 1;
  });
}
