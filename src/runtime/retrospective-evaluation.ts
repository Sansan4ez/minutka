import { Command } from "commander";
import { readFile, realpath, open } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { RetrospectiveEvaluationService, renderRetrospectiveEvaluation, type RetrospectiveEvaluationRead } from "../application/retrospective-evaluation.js";

/** Offline private research exports: no live writes, delivery or public DTO. */
export async function runRetrospectiveEvaluationCommand(argv: string[], options: { repoRoot?: string } = {}) {
  const program = new Command().name("retrospective-evaluation").exitOverride()
    .description("Evaluate a private research bundle {corpus, artifacts, measurements?}; output outside Git")
    .requiredOption("--company <id>").requiredOption("--group <id>")
    .requiredOption("--from <timestamp>").requiredOption("--to <timestamp>")
    .requiredOption("--input <path>").requiredOption("--output <path>");
  program.action(async (flags: { company: string; group: string; from: string; to: string; input: string; output: string }) => {
    const root = await realpath(options.repoRoot ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    const output = resolve(await realpath(dirname(resolve(flags.output))), resolve(flags.output).split("/").at(-1)!);
    const rel = relative(root, output);
    if (!rel || (!rel.startsWith("../") && !isAbsolute(rel))) throw new Error("private output must be outside the repository");
    // Exclusive create avoids overwriting or following an existing output symlink.
    const input = JSON.parse(await readFile(flags.input, "utf8")) as Awaited<ReturnType<RetrospectiveEvaluationRead["read"]>>;
    const service = new RetrospectiveEvaluationService({ read: async () => input });
    const result = await service.evaluate({ companyId: flags.company, groupId: flags.group, start: flags.from, end: flags.to });
    const handle = await open(output, "wx", 0o600);
    try { await handle.writeFile(renderRetrospectiveEvaluation(result)); } finally { await handle.close(); }
  });
  try { await program.parseAsync(argv, { from: "user" }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "commander.helpDisplayed")) throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRetrospectiveEvaluationCommand(process.argv.slice(2));
}
