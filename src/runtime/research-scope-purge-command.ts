import { Command } from "commander";
import type { ResearchScopePurgeService } from "../application/research-scope-purge.js";

export type ResearchScopePurgeCommandDeps = {
  service: Pick<ResearchScopePurgeService, "preview" | "purge">;
  /** Reads the operator's typed level-2 confirmation line. */
  readConfirmation(): Promise<string>;
  write(text: string): void;
};

/**
 * Operator-only entry point. Preview always runs first, so the exact scope and
 * its counts are on screen before the irreversible confirmation is requested.
 */
export async function runResearchScopePurgeCommand(
  argv: string[],
  deps: ResearchScopePurgeCommandDeps,
): Promise<void> {
  const program = new Command().name("research-scope-purge").exitOverride();
  program
    .requiredOption("--company <companyId>")
    .option("--group <groupId>", "restrict the purge to one training group of that company")
    .option("--preview", "print the scope and its counts, then exit without deleting anything")
    .action(async (options: { company: string; group?: string; preview?: boolean }) => {
      const scope = { companyId: options.company, ...(options.group ? { groupId: options.group } : {}) };
      const preview = await deps.service.preview(scope);
      deps.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (options.preview) return;
      deps.write([
        "This irreversible level-2 operation deletes the participants of the scope above together with their profiles, conversations, canonical activities, research traces, feedback, evaluation cases, personal insights, audit events and every MinIO object version.",
        "It preserves the tenant reference directories, an identity-free purge audit record, and any client artifact already delivered.",
        `Type exactly '${preview.confirmation}' to continue: `,
      ].join("\n"));
      if ((await deps.readConfirmation()).trim() !== preview.confirmation) {
        throw new Error("confirmation did not match; nothing was purged");
      }
      deps.write(`${JSON.stringify(await deps.service.purge(scope), null, 2)}\n`);
    });
  await program.parseAsync(argv, { from: "user" });
}
