export type CompanyRole = {
  id: string;
  companyId: string;
  name: string;
};

/**
 * The training group's programme cycle as inclusive local calendar dates. The
 * company report and the personal final report count the same cycle from it.
 */
export type TrainingGroupPeriod = { start: string; end: string };

/** Read-only application boundary over operator-managed tenant directories. */
export type TenantDirectoryStore = {
  groupBelongsToCompany(input: { companyId: string; groupId: string }): Promise<boolean>;
  /** Undefined when the group is not in this company's directory. */
  getGroupPeriod(input: { companyId: string; groupId: string }): Promise<TrainingGroupPeriod | undefined>;
  listRoles(companyId: string): Promise<CompanyRole[]>;
  getRole(input: { companyId: string; roleId: string }): Promise<CompanyRole | undefined>;
};
