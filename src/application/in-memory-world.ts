import type { DomainEvent } from "../domain/events.js";

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
  counters: { message: number };
  now: () => string;
};

export function createInMemoryWorld(
  now: () => string = () => new Date().toISOString(),
): InMemoryWorld {
  return {
    messages: [],
    events: [],
    counters: { message: 0 },
    now,
  };
}
