import { Command } from "commander";
import type { FinalReportArmingService } from "../application/final-report-arming.js";

/** Inside the working day, so the employee can still read and answer the cycle result. */
export const defaultFinalReportTimeOfDay = "17:00";

export type ArmFinalReportsCommandDeps = {
  service: Pick<FinalReportArmingService, "preview" | "arm">;
  /** Reads the operator's typed confirmation line. */
  readConfirmation(): Promise<string>;
  write(text: string): void;
};

/**
 * Operator-only end of the cycle for one training group. Preview always runs
 * first, so the exact scope, the local time, and the number of recipients are on
 * screen before the group receives anything.
 */
export async function runArmFinalReportsCommand(
  argv: string[],
  deps: ArmFinalReportsCommandDeps,
): Promise<void> {
  const program = new Command().name("arm-final-reports").exitOverride();
  program
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>", "the training group whose two-week cycle ends")
    .option("--at <timeOfDay>", "local HH:MM of each employee's own timezone", defaultFinalReportTimeOfDay)
    .option("--preview", "print the scope and the recipient counts, then exit without arming anything")
    .action(async (options: { company: string; group: string; at: string; preview?: boolean }) => {
      const input = { companyId: options.company, groupId: options.group, timeOfDay: options.at };
      const preview = await deps.service.preview(input);
      deps.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (options.preview) return;
      if (!preview.eligible) throw new Error("no onboarded participant in this group; nothing was armed");
      deps.write([
        `This sends one final personal report to ${preview.eligible} onboarded participant(s) of ${preview.companyId}/${preview.groupId} at ${preview.timeOfDay} in each employee's own timezone.`,
        "The report stays inside the employee's personal contour: it is not part of the company artifact and the methodologist does not receive it.",
        `Type exactly '${preview.confirmation}' to continue: `,
      ].join("\n"));
      if ((await deps.readConfirmation()).trim() !== preview.confirmation) {
        throw new Error("confirmation did not match; nothing was armed");
      }
      deps.write(`${JSON.stringify(await deps.service.arm(input), null, 2)}\n`);
    });
  await program.parseAsync(argv, { from: "user" });
}
