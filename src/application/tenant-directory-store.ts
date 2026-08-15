export type CompanyRole = {
  id: string;
  companyId: string;
  name: string;
};

/** Read-only application boundary over operator-managed tenant directories. */
export type TenantDirectoryStore = {
  groupBelongsToCompany(input: { companyId: string; groupId: string }): Promise<boolean>;
  listRoles(companyId: string): Promise<CompanyRole[]>;
  getRole(input: { companyId: string; roleId: string }): Promise<CompanyRole | undefined>;
};
