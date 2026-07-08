import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { DomainEvent } from "../domain/events.js";
import type { StructuredInsight } from "../domain/insights.js";

export type ChatMessage = {
  id: string;
  employeeId: string;
  threadId: string;
  text: string;
  response: string;
  timestamp: string;
};

export type InMemoryWorld = {
  messages: ChatMessage[];
  events: DomainEvent[];
  participants: Participant[];
  consents: Consent[];
  profiles: UserProfile[];
  insights: StructuredInsight[];
  counters: { message: number; participant: number; insight: number };
  now: () => string;
};

export function createInMemoryWorld(
  now: () => string = () => new Date().toISOString(),
): InMemoryWorld {
  return {
    messages: [],
    events: [],
    participants: [],
    consents: [],
    profiles: [],
    insights: [],
    counters: { message: 0, participant: 0, insight: 0 },
    now,
  };
}
