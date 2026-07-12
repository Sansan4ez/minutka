export type RuntimeAccessScope = {
  employeeId: string;
  threadId?: string;
  requestId: string;
  purpose: "chat" | "feedback" | "onboarding" | "audit";
};
