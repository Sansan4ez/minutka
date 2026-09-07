import { readFile } from "node:fs/promises";
import { stdout } from "node:process";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  RoutineDirectoryError,
  loadRoutineDirectory,
  routineDirectoryCounts,
} from "../application/routine-directory.js";

export async function runRoutineDirectoryCommand(argv: string[], write: (text: string) => void = (text) => stdout.write(text)): Promise<void> {
  const program = new Command().name("routine-directory").exitOverride();
  program.command("validate")
    .requiredOption("--company <companyId>")
    .requiredOption("--file <path>")
    .action(async (options: { company: string; file: string }) => {
      const text = await readFile(resolve(options.file), "utf8");
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        write(`${JSON.stringify({ ok: false, code: "directory_schema_invalid", message: "routine directory JSON is invalid" }, null, 2)}\n`);
        return;
      }
      try {
        const directory = loadRoutineDirectory(json, { expectedCompanyId: options.company });
        write(`${JSON.stringify({ ok: true, version: directory.version, ...routineDirectoryCounts(directory) }, null, 2)}\n`);
      } catch (error) {
        if (!(error instanceof RoutineDirectoryError)) throw error;
        write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
      }
    });
  await program.parseAsync(argv, { from: "user" });
}

if (process.argv[1]?.endsWith("/routine-directory.ts") || process.argv[1]?.endsWith("/routine-directory.js")) {
  await runRoutineDirectoryCommand(process.argv.slice(2));
}
