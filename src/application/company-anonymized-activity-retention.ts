import { z } from "zod";

export type CompanyAnonymizedActivityRetentionStore = {
  deleteByCompany(companyId: string): Promise<number>;
};

const purgeCompanyAnonymizedActivitiesInputSchema = z.strictObject({
  companyId: z.string().trim().min(1),
});

export type PurgeCompanyAnonymizedActivitiesInput = z.input<typeof purgeCompanyAnonymizedActivitiesInputSchema>;

/** Typed operator boundary for end-of-pilot retention and emergency resets. */
export class CompanyAnonymizedActivityRetentionService {
  constructor(private readonly store: CompanyAnonymizedActivityRetentionStore) {}

  async purgeCompany(input: PurgeCompanyAnonymizedActivitiesInput): Promise<{
    companyId: string;
    deletedRows: number;
  }> {
    const { companyId } = purgeCompanyAnonymizedActivitiesInputSchema.parse(input);
    const deletedRows = await this.store.deleteByCompany(companyId);
    return { companyId, deletedRows };
  }
}
