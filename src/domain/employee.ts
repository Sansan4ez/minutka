export type UserProfile = {
  employeeId: string;
  role: string;
  persona: "support" | "efficiency";
  aiLevel: "beginner" | "intermediate" | "advanced";
  createdAt: string;
};
