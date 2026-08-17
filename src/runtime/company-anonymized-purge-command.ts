import type { CompanyAnonymizedActivityRetentionService } from "../application/company-anonymized-activity-retention.js";

export type CompanyAnonymizedPurgeCommandInput = {
  companyId: string;
  retention: CompanyAnonymizedActivityRetentionService;
  interactiveTerminal: boolean;
  readConfirmation: () => Promise<string>;
  write: (text: string) => void;
};

export async function runCompanyAnonymizedPurgeCommand(
  input: CompanyAnonymizedPurgeCommandInput,
): Promise<{ companyId: string; expectedRows: number; deletedRows: number }> {
  const preview = await input.retention.previewCompany({ companyId: input.companyId });
  input.write(`Preview: companyId=${preview.companyId}, expectedRows=${preview.expectedRows}\n`);

  if (preview.expectedRows === 0) {
    const result = { ...preview, deletedRows: 0 };
    input.write("No anonymized rows found; nothing was deleted.\n");
    input.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  if (!input.interactiveTerminal) {
    throw new Error("interactive TTY confirmation is required; nothing was deleted");
  }

  const confirmation = `PURGE ${preview.companyId} ${preview.expectedRows}`;
  input.write([
    `This irreversible level-2 operation deletes ${preview.expectedRows} anonymized rows for company '${preview.companyId}'.`,
    "There is no backfill: the anonymized slice cannot be restored after deletion.",
    `Type exactly '${confirmation}' to continue: `,
  ].join("\n"));

  let answer: string;
  try {
    answer = await input.readConfirmation();
  } catch {
    throw new Error("confirmation was not received; nothing was deleted");
  }
  if (answer !== confirmation) {
    throw new Error("confirmation did not match; nothing was deleted");
  }

  const result = await input.retention.purgeCompany({
    companyId: preview.companyId,
    expectedRows: preview.expectedRows,
  });
  input.write(`${JSON.stringify(result)}\n`);
  return result;
}
