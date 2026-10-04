import type { Pool } from "pg";
import { createRetrospectiveStore } from "../../application/in-memory-work-retrospective-store.js";
import { createPostgresConversationStore } from "./postgres-conversation-store.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresWorkRetrospectiveStore(pool: Pool) {
  return createRetrospectiveStore(createPostgresConversationStore(pool), {
    async replace(scope, episodes) {
      await withTransaction(pool, async (client) => {
        await client.query(`DELETE FROM minutka_private.retrospective_episodes WHERE employee_id=$1 AND thread_id=$2 AND company_id=$3 AND group_id=$4 AND subject_key=$5`, [scope.employeeId, scope.threadId, scope.companyId, scope.groupId, scope.subjectKey]);
        for (const episode of episodes) {
          await client.query(`INSERT INTO minutka_private.retrospective_episodes(employee_id,thread_id,company_id,group_id,subject_key,episode_id,pending,projection) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.employeeId, scope.threadId, scope.companyId, scope.groupId, scope.subjectKey, episode.episodeId, !!episode.pendingQuestion, episode]);
        }
      });
    },
  });
}
