import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { safeAuditMetadata } from "../../application/audit-event-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  researchScopePurgeAuditMetadata,
  type ResearchScope,
  type ResearchScopePurgeCounts,
  type ResearchScopePurgeStore,
} from "../../application/research-scope-purge.js";
import { systemClock, type Clock } from "../../application/runtime-primitives.js";
import { withTransaction } from "./postgres-pool.js";

/** Exact company, or exact company/group; the scope is never widened here. */
function scopeQuery(scope: ResearchScope) {
  const where = scope.groupId ? "company_id = $1 AND group_id = $2" : "company_id = $1";
  return {
    where,
    params: scope.groupId ? [scope.companyId, scope.groupId] : [scope.companyId],
    employeeIds: `SELECT employee_id FROM minutka_private.participants WHERE ${where}`,
  };
}

async function countResearchScope(client: Pool | PoolClient, scope: ResearchScope): Promise<ResearchScopePurgeCounts> {
  const { where, params, employeeIds } = scopeQuery(scope);
  const count = async (query: string) =>
    Number((await client.query<{ count: string }>(query, params)).rows[0]!.count);
  const owned = (table: string, ownerColumn: "employee_id" | "user_id" | "owner_id") =>
    count(`SELECT count(*) FROM ${table} WHERE ${ownerColumn} IN (${employeeIds})`);
  const tenant = (table: string) => count(`SELECT count(*) FROM ${table} WHERE ${where}`);
  return {
    participants: await count(`SELECT count(*) FROM minutka_private.participants WHERE ${where}`),
    profiles: await owned("minutka_private.profiles", "employee_id"),
    consents: await owned("minutka_private.consents", "employee_id"),
    conversations: await owned("minutka_private.threads", "employee_id"),
    threadSummaries: await owned("minutka_private.thread_summaries", "employee_id"),
    messages: await owned("minutka_private.messages", "employee_id"),
    activities: await owned("minutka_private.activities", "employee_id"),
    insights: await owned("minutka_private.insights", "employee_id"),
    feedback: await owned("minutka_private.feedback", "employee_id"),
    schedules: await owned("minutka_private.process_schedules", "user_id"),
    scheduleFires: await owned("minutka_private.schedule_fires", "user_id"),
    telegramSessions: await owned("minutka_private.telegram_sessions", "employee_id"),
    telegramActionMessages: await owned("minutka_private.telegram_action_messages", "employee_id"),
    onboardingDrafts: await owned("minutka_private.onboarding_drafts", "employee_id"),
    pendingActionGroups: await owned("minutka_private.telegram_pending_action_groups", "owner_id"),
    ideas: await owned("minutka_private.ideas", "user_id"),
    ideaDeletionConfirmations: await owned("minutka_private.idea_deletion_confirmations", "user_id"),
    tasks: await owned("minutka_private.tasks", "user_id"),
    taskMutationConfirmations: await owned("minutka_private.task_mutation_confirmations", "user_id"),
    contextDocumentConfirmations: await owned("minutka_private.context_document_confirmations", "user_id"),
    artifacts: await owned("minutka_private.artifacts", "user_id"),
    artifactContents: await owned("minutka_private.artifact_contents", "user_id"),
    auditEvents: await owned("minutka_audit.events", "employee_id"),
    // Owner-scoped usage rows are personal records and go with their participant.
    usageRecords: await owned("minutka_private.usage", "user_id"),
    traces: await tenant("minutka_research.traces"),
    evaluationCases: await tenant("minutka_research.evaluation_cases"),
  };
}

/**
 * Operator-only company and company/group purge. Every canonical and research
 * row of a subject hangs off `minutka_private.participants` through the
 * composite tenant/subject keys, so deleting the participants of one exact
 * scope cascades to messages, activities, traces and evaluation cases without
 * touching another company or another group of the same company. Tenant
 * reference directories are deliberately preserved: they carry no research data
 * and the same group may be invited again.
 */
export function createPostgresResearchScopePurgeStore(
  pool: Pool,
  clock: Clock = systemClock,
): ResearchScopePurgeStore {
  return {
    async countScope(scope) {
      try {
        return await countResearchScope(pool, scope);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listScopeEmployeeIds(scope) {
      try {
        const { where, params } = scopeQuery(scope);
        const result = await pool.query<{ employee_id: string }>(
          `SELECT employee_id FROM minutka_private.participants WHERE ${where} ORDER BY employee_id`,
          params,
        );
        return result.rows.map((row) => row.employee_id);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async purgeScope({ deletedObjectVersions, ...scope }) {
      try {
        return await withTransaction(pool, async (client) => {
          const { where, params, employeeIds } = scopeQuery(scope);
          const counts = await countResearchScope(client, scope);
          // Employee-linked audit rows go first; the record kept below is
          // deliberately identity-free and carries only scope, counts and
          // outcome, so it survives the participants it describes.
          await client.query(`DELETE FROM minutka_audit.events WHERE employee_id IN (${employeeIds})`, params);
          await client.query(`DELETE FROM minutka_private.participants WHERE ${where}`, params);
          await client.query(
            `INSERT INTO minutka_audit.events(event_id, request_id, event_type, metadata, occurred_at)
             VALUES ($1, $2, 'research_scope_purged', $3::jsonb, $4)`,
            [
              randomUUID(),
              randomUUID(),
              JSON.stringify(safeAuditMetadata(
                "research_scope_purged",
                researchScopePurgeAuditMetadata(scope, counts, deletedObjectVersions),
              )),
              clock.now(),
            ],
          );
          return counts;
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
