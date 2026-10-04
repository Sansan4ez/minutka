import type { Pool } from "pg";
import type { ActivityTransactionServiceResult } from "../../application/activity-transaction-service.js";
import type { LinkedActivityTransactionKey, LinkedActivityTransactionStore } from "../../application/linked-activity-transaction-store.js";

const values = (key: LinkedActivityTransactionKey) => [key.employeeId, key.companyId, key.groupId, key.subjectKey, key.threadId, key.sourceMessageId, key.ordinal];
const selection = "employee_id=$1 AND company_id=$2 AND group_id=$3 AND subject_key=$4 AND thread_id=$5 AND source_message_id=$6 AND ordinal=$7";
export function createPostgresLinkedActivityTransactionStore(pool: Pool): LinkedActivityTransactionStore {
  return {
    async claim(key) {
      const inserted = await pool.query(`INSERT INTO minutka_private.linked_activity_transactions(employee_id,company_id,group_id,subject_key,thread_id,source_message_id,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING ordinal`, values(key));
      if (inserted.rowCount) return { status: "claimed" };
      const existing = await pool.query<{ outcome: ActivityTransactionServiceResult | null }>(`SELECT outcome FROM minutka_private.linked_activity_transactions WHERE ${selection}`, values(key));
      const outcome = existing.rows[0]?.outcome;
      return { status: "existing", ...(outcome ? { outcome } : {}) };
    },
    async complete(key, outcome) {
      const result = await pool.query(`UPDATE minutka_private.linked_activity_transactions SET outcome=$8 WHERE ${selection} AND outcome IS NULL`, [...values(key), JSON.stringify(outcome)]);
      if (result.rowCount !== 1) throw new Error("Linked transaction reservation conflict");
    },
  };
}
