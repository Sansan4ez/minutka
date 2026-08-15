import type { CompanyRole, TenantDirectoryStore } from "./tenant-directory-store.js";

export type InMemoryTenantDirectories = {
  groups: Array<{ id: string; companyId: string }>;
  roles: CompanyRole[];
};

export function createInMemoryTenantDirectoryStore(
  directories: InMemoryTenantDirectories,
): TenantDirectoryStore {
  return {
    async groupBelongsToCompany({ companyId, groupId }) {
      return directories.groups.some((group) => group.id === groupId && group.companyId === companyId);
    },
    async listRoles(companyId) {
      return directories.roles
        .filter((role) => role.companyId === companyId)
        .sort((left, right) => left.name.localeCompare(right.name, "ru"));
    },
    async getRole({ companyId, roleId }) {
      return directories.roles.find((role) => role.id === roleId && role.companyId === companyId);
    },
  };
}
