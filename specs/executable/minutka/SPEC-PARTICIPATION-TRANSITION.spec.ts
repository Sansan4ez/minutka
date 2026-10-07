import { describe, expect, it } from "vitest";
import { ParticipationTransitionService } from "../../../src/application/participation-transition.js";

describe("operator participation transition", () => {
  it("validates exact separate company/group participation before writes", async () => {
    let calls = 0;
    const service = new ParticipationTransitionService({ async transition() { calls++; return { status: "applied", threadId: "new" }; } });
    const input = { companyId: "company", sourceGroupId: "old", targetGroupId: "new", sourceEmployeeId: "old_employee", targetEmployeeId: "new_employee" };
    expect(() => service.transition({ ...input, targetEmployeeId: input.sourceEmployeeId })).toThrow();
    expect(() => service.transition({ ...input, targetGroupId: input.sourceGroupId })).toThrow();
    expect(calls).toBe(0);
    expect(await service.transition(input)).toEqual({ status: "applied", threadId: "new" });
    expect(calls).toBe(1);
  });
});
