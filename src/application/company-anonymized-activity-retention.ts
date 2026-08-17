import { z } from "zod";

export class CompanyAnonymizedActivityRetentionMismatchError extends Error {
  constructor(
    readonly companyId: string,
    readonly expectedRows: number,
    readonly actualRows: number,
  ) {
    super(`anonymized activity count changed for company '${companyId}': expected ${expectedRows}, found ${actualRows}; nothing was deleted; run the command again`);
    this.name = "CompanyAnonymizedActivityRetentionMismatchError";
  }
}

export type CompanyAnonymizedActivityRetentionStore = {
  countByCompany(companyId: string): Promise<number>;
  deleteByCompany(companyId: string, expectedRows: number): Promise<number>;
};

const companyInputSchema = z.strictObject({
  companyId: z.string().trim().min(1),
});

const purgeCompanyAnonymizedActivitiesInputSchema = companyInputSchema.extend({
  expectedRows: z.number().int().nonnegative(),
});

export type PreviewCompanyAnonymizedActivitiesInput = z.input<typeof companyInputSchema>;
export type PurgeCompanyAnonymizedActivitiesInput = z.input<typeof purgeCompanyAnonymizedActivitiesInputSchema>;

/** Typed operator boundary for end-of-pilot retention and emergency resets. */
export class CompanyAnonymizedActivityRetentionService {
  constructor(private readonly store: CompanyAnonymizedActivityRetentionStore) {}

  async previewCompany(input: PreviewCompanyAnonymizedActivitiesInput): Promise<{
    companyId: string;
    expectedRows: number;
  }> {
    const { companyId } = companyInputSchema.parse(input);
    return { companyId, expectedRows: await this.store.countByCompany(companyId) };
  }

  async purgeCompany(input: PurgeCompanyAnonymizedActivitiesInput): Promise<{
    companyId: string;
    expectedRows: number;
    deletedRows: number;
  }> {
    const { companyId, expectedRows } = purgeCompanyAnonymizedActivitiesInputSchema.parse(input);
    const deletedRows = await this.store.deleteByCompany(companyId, expectedRows);
    return { companyId, expectedRows, deletedRows };
  }
}
