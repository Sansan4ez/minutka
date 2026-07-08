import { Command } from "commander";
import type { MinutkaClient } from "../sdk/minutka-client.js";

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

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

  program
    .command("employee")
    .description("Employee commands")
    .addCommand(
      new Command("chat")
        .requiredOption("--employee <employeeId>")
        .option("--thread <threadId>", "Thread ID (defaults to employeeId)")
        .requiredOption("--text <text>")
        .action(async (options: { employee: string; thread?: string; text: string }) => {
          const result = await client.chat({
            employeeId: options.employee,
            threadId: options.thread ?? options.employee,
            text: options.text,
          });
          stdout.push(JSON.stringify(result));
        }),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(message);
    return { exitCode: 1, stdout, stderr };
  }
}
