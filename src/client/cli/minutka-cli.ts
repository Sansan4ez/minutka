import { Command } from "commander";
import type { MinutkaClient } from "../sdk/minutka-client.js";

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

function collect(value: string, previous: string[]) {
  return [...previous, value];
}

function parseChoice<const T extends readonly string[]>(
  value: string,
  choices: T,
  label: string,
): T[number] {
  if (choices.includes(value)) return value;
  throw new Error(`${label} must be one of: ${choices.join(", ")}`);
}

function parsePersona(value: string) {
  return parseChoice(value, ["support", "efficiency"] as const, "persona");
}

function parseAiLevel(value: string) {
  return parseChoice(
    value,
    ["beginner", "intermediate", "advanced"] as const,
    "ai-level",
  );
}

function parseResponseLength(value: string) {
  return parseChoice(
    value,
    ["short", "balanced", "detailed"] as const,
    "response-length",
  );
}

function parseInsightKind(value: string) {
  return parseChoice(
    value,
    [
      "task_category",
      "routine_pattern",
      "energy_stress_marker",
      "automation_candidate",
    ] as const,
    "kind",
  );
}

export async function runMinutkaCli(
  client: MinutkaClient,
  argv: string[],
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();

  program
    .name("minutka")
    .exitOverride()
    .configureOutput({
      writeOut: (v) => stdout.push(v.trim()),
      writeErr: (v) => stderr.push(v.trim()),
    });

  const employee = new Command("employee").description("Employee commands");

  employee.addCommand(
    new Command("open-invite")
      .requiredOption("--invite <inviteCode>")
      .option("--employee <employeeId>")
      .action(
        async (options: { invite: string; employee?: string }) => {
          const result = await client.openInvite({
            inviteCode: options.invite,
            employeeId: options.employee,
          });
          stdout.push(JSON.stringify(result));
        },
      ),
  );

  employee.addCommand(
    new Command("accept-consent")
      .requiredOption("--employee <employeeId>")
      .option("--yes", "Explicitly accept privacy consent")
      .action(async (options: { employee: string; yes?: boolean }) => {
        if (options.yes !== true) {
          throw new Error("privacy consent must be explicitly accepted");
        }
        const result = await client.acceptConsent({
          employeeId: options.employee,
          accepted: true,
          source: "cli",
        });
        stdout.push(JSON.stringify(result));
      }),
  );

  employee.addCommand(
    new Command("complete-onboarding")
      .requiredOption("--employee <employeeId>")
      .requiredOption("--role <role>")
      .option("--task <task>", "Typical task", collect, [])
      .requiredOption("--persona <persona>", "support|efficiency", parsePersona)
      .requiredOption(
        "--ai-level <level>",
        "beginner|intermediate|advanced",
        parseAiLevel,
      )
      .option(
        "--response-length <length>",
        "short|balanced|detailed",
        parseResponseLength,
      )
      .action(
        async (options: {
          employee: string;
          role: string;
          task: string[];
          persona: "support" | "efficiency";
          aiLevel: "beginner" | "intermediate" | "advanced";
          responseLength?: "short" | "balanced" | "detailed";
        }) => {
          const result = await client.completeOnboarding({
            employeeId: options.employee,
            role: options.role,
            typicalTasks: options.task,
            persona: options.persona,
            aiLevel: options.aiLevel,
            responseLength: options.responseLength,
          });
          stdout.push(JSON.stringify(result));
        },
      ),
  );

  employee.addCommand(
    new Command("profile")
      .requiredOption("--employee <employeeId>")
      .action(async (options: { employee: string }) => {
        const result = await client.getProfile({ employeeId: options.employee });
        stdout.push(JSON.stringify(result));
      }),
  );

  employee.addCommand(
    new Command("chat")
      .requiredOption("--employee <employeeId>")
      .option("--thread <threadId>", "Thread ID (defaults to employeeId)")
      .requiredOption("--text <text>")
      .action(
        async (options: { employee: string; thread?: string; text: string }) => {
          const result = await client.chat({
            employeeId: options.employee,
            threadId: options.thread ?? options.employee,
            text: options.text,
          });
          stdout.push(JSON.stringify(result));
        },
      ),
  );

  employee.addCommand(
    new Command("insights")
      .option("--employee <employeeId>")
      .option("--thread <threadId>")
      .option("--kind <kind>", "Insight kind", parseInsightKind)
      .action(
        async (options: {
          employee?: string;
          thread?: string;
          kind?: ReturnType<typeof parseInsightKind>;
        }) => {
          const result = await client.listInsights({
            employeeId: options.employee,
            threadId: options.thread,
            kind: options.kind,
          });
          stdout.push(JSON.stringify(result));
        },
      ),
  );

  employee.addCommand(
    new Command("feedback")
      .requiredOption("--employee <employeeId>")
      .option("--thread <threadId>", "Thread ID (defaults to employeeId)")
      .requiredOption("--target-message <targetMessageId>")
      .requiredOption("--rating <rating>")
      .action(
        async (options: { employee: string; thread?: string; targetMessage: string; rating: string }) => {
          if (options.rating !== "positive" && options.rating !== "neutral" && options.rating !== "negative") {
            throw new Error("rating must be positive, neutral, or negative");
          }
          const result = await client.submitFeedback({
            employeeId: options.employee,
            threadId: options.thread ?? options.employee,
            targetMessageId: options.targetMessage,
            rating: options.rating,
            source: "cli",
          });
          stdout.push(JSON.stringify(result));
        },
      ),
  );

  program.addCommand(employee);

  try {
    await program.parseAsync(argv, { from: "user" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(message);
    return { exitCode: 1, stdout, stderr };
  }
}
