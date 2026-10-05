import type { Pool } from "pg";
import type { MutableWorkRetrospectivePolicyStore } from "../../application/work-retrospective-policy.js";
import { workRetrospectivePolicySchema } from "../../application/work-retrospective-store.js";

export function createPostgresWorkRetrospectivePolicyStore(pool: Pool): MutableWorkRetrospectivePolicyStore {
  return {
    async read(scope) {
      const result = await pool.query("SELECT policy FROM minutka_private.retrospective_policies WHERE company_id=$1 AND group_id=$2", [scope.companyId, scope.groupId]);
      return result.rows[0] ? workRetrospectivePolicySchema.parse(result.rows[0].policy) : undefined;
    },
    async write(policy) {
      const value = workRetrospectivePolicySchema.parse(policy);
      await pool.query(`INSERT INTO minutka_private.retrospective_policies(company_id,group_id,policy) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(company_id,group_id) DO UPDATE SET policy=EXCLUDED.policy`, [value.companyId, value.groupId, JSON.stringify(value)]);
    },
    async purge(scope) {
      const result = await pool.query("DELETE FROM minutka_private.retrospective_policies WHERE company_id=$1 AND ($2::text IS NULL OR group_id=$2)", [scope.companyId, scope.groupId ?? null]);
      return result.rowCount ?? 0;
    },
  };
}
