import type { TenantDirectoryStore } from "../../application/tenant-directory-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";

type RoleRow = { id: string; company_id: string; name: string };

export function createPostgresTenantDirectoryStore(pool: Pool): TenantDirectoryStore {
  return {
    async groupBelongsToCompany({ companyId, groupId }) {
      try {
        const result = await pool.query(
          "SELECT 1 FROM minutka_reference.training_groups WHERE company_id = $1 AND id = $2",
          [companyId, groupId],
        );
        return result.rowCount === 1;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listRoles(companyId) {
      try {
        const result = await pool.query<RoleRow>(
          "SELECT id, company_id, name FROM minutka_reference.roles WHERE company_id = $1 ORDER BY name, id",
          [companyId],
        );
        return result.rows.map((row) => ({ id: row.id, companyId: row.company_id, name: row.name }));
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getRole({ companyId, roleId }) {
      try {
        const result = await pool.query<RoleRow>(
          "SELECT id, company_id, name FROM minutka_reference.roles WHERE company_id = $1 AND id = $2",
          [companyId, roleId],
        );
        const row = result.rows[0];
        return row ? { id: row.id, companyId: row.company_id, name: row.name } : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
