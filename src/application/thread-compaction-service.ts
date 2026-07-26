import type { AuditEventStore } from "./audit-event-store.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";
import { countUnicodeCharacters } from "./context-budget.js";
import type { InsightExtractor } from "./insight-extractor.js";
import type { InsightStore } from "./insight-store.js";
import type { ThreadSummarizer } from "./thread-summarizer.js";
import type { ThreadSummary, ThreadSummaryStore } from "./thread-summary-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";

export type ThreadCompactionService = {
  compact(input: { employeeId: string; threadId: string; requestId: string }): Promise<void>;
};

export function createThreadCompactionService(deps: {
  conversationStore: ConversationStore;
  summaryStore: ThreadSummaryStore;
  summarizer: ThreadSummarizer;
  recentTurnLimit: number;
  summaryCeiling: number;
  clock: Clock;
  idGenerator: IdGenerator;
  auditEventStore?: AuditEventStore;
  insightExtractor?: InsightExtractor;
  insightStore?: InsightStore;
}): ThreadCompactionService {
  const queues = new Map<string, Promise<void>>();
  const runCompaction = async (input: { employeeId: string; threadId: string; requestId: string }): Promise<void> => {
      let previous: ThreadSummary | undefined;
      let pending: ConversationTurn[];
      try {
        previous = await deps.summaryStore.get(input);
        pending = await deps.conversationStore.getTurnsBeforeRecent({
          employeeId: input.employeeId,
          threadId: input.threadId,
          recentLimit: deps.recentTurnLimit,
          afterMessageId: previous?.watermark.throughMessageId,
        });
      } catch (error) {
        await auditSafely(deps, input, undefined, "thread_summary_failed", {
          reason: errorReason(error),
          turnCount: 0,
          previousCharacters: 0,
        });
        return;
      }
      if (pending.length === 0) return;

      await extractInsightsSafely(pending, input, deps);

      let generated: { text: string };
      let reduced = false;
      try {
        generated = await deps.summarizer({ previous, turns: pending, ceiling: deps.summaryCeiling, reduce: false });
        if (countUnicodeCharacters(generated.text) > deps.summaryCeiling) {
          reduced = true;
          generated = await deps.summarizer({ previous, turns: pending, ceiling: deps.summaryCeiling, reduce: true });
        }
        if (countUnicodeCharacters(generated.text) > deps.summaryCeiling) {
          throw new Error("summary_ceiling_exceeded_after_reduction");
        }
        assertStructuredSummary(generated.text);
      } catch (error) {
        await auditSafely(deps, input, pending.at(-1)?.messageId, "thread_summary_failed", {
          reason: errorReason(error),
          turnCount: pending.length,
          previousCharacters: previous ? countUnicodeCharacters(previous.text) : 0,
        });
        return;
      }

      const summary: ThreadSummary = {
        employeeId: input.employeeId,
        threadId: input.threadId,
        text: generated.text,
        watermark: {
          fromMessageId: previous?.watermark.fromMessageId ?? pending[0]!.messageId,
          throughMessageId: pending.at(-1)!.messageId,
        },
        updatedAt: deps.clock.now(),
      };
      try {
        await deps.summaryStore.save(summary);
      } catch (error) {
        await auditSafely(deps, input, summary.watermark.throughMessageId, "thread_summary_failed", {
          reason: errorReason(error),
          turnCount: pending.length,
          previousCharacters: previous ? countUnicodeCharacters(previous.text) : 0,
        });
        return;
      }
      await auditSafely(deps, input, summary.watermark.throughMessageId, "thread_summary_updated", {
        turnCount: pending.length,
        summaryCharacters: countUnicodeCharacters(summary.text),
        reduced,
      });
  };
  return {
    compact(input) {
      const key = `${input.employeeId}\u0000${input.threadId}`;
      const previous = queues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => runCompaction(input));
      queues.set(key, current);
      void current.finally(() => {
        if (queues.get(key) === current) queues.delete(key);
      });
      return current;
    },
  };
}

async function extractInsightsSafely(
  turns: ConversationTurn[],
  input: { employeeId: string; threadId: string; requestId: string },
  deps: Parameters<typeof createThreadCompactionService>[0],
): Promise<void> {
  if (!deps.insightExtractor || !deps.insightStore) return;
  try {
    for (const turn of turns) {
      const extraction = await deps.insightExtractor({
        employeeId: input.employeeId,
        threadId: input.threadId,
        messageId: turn.messageId,
        text: turn.userText,
        response: turn.agentResponse,
        recentTurns: [turn],
        decision: {
          selectedProcessIds: ["core", "insight_extraction"],
          workDecision: { mode: "allow", reason: "workday_reflection" },
          insightDecision: {
            candidate: true,
            suggestedKinds: ["task_category", "routine_pattern", "energy_stress_marker", "automation_candidate"],
          },
        },
      });
      await deps.insightStore.saveInsights(extraction.insights.map((draft) => ({
        ...draft,
        id: deps.idGenerator.insightId(),
        createdAt: deps.clock.now(),
      })));
    }
  } catch (error) {
    await auditSafely(deps, input, turns.at(-1)?.messageId, "thread_compaction_insight_failed", {
      reason: errorReason(error),
      turnCount: turns.length,
    });
  }
}

function assertStructuredSummary(text: string): void {
  for (const heading of ["Факты", "Решения", "Договорённости", "Открытые вопросы"]) {
    if (!text.includes(`## ${heading}`)) throw new Error("summary_sections_missing");
  }
}

async function auditSafely(
  deps: Parameters<typeof createThreadCompactionService>[0],
  input: { employeeId: string; threadId: string; requestId: string },
  messageId: string | undefined,
  type: "thread_summary_updated" | "thread_summary_failed" | "thread_compaction_insight_failed",
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (!deps.auditEventStore) return;
  try {
    await deps.auditEventStore.append({
      id: deps.idGenerator.auditEventId(),
      requestId: input.requestId,
      type,
      employeeId: input.employeeId,
      threadId: input.threadId,
      ...(messageId ? { messageId } : {}),
      occurredAt: deps.clock.now(),
      metadata,
    });
  } catch (error) {
    console.warn(`Assistant thread compaction audit failed (${error instanceof Error ? error.name : "UnknownError"}).`);
  }
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message === "summary_ceiling_exceeded_after_reduction") return error.message;
  if (error instanceof Error && error.message === "summary_sections_missing") return error.message;
  return error instanceof Error ? error.name : "UnknownError";
}
