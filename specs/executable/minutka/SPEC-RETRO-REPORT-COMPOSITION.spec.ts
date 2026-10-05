import { describe, expect, it } from "vitest";
import { setup } from "./SPEC-RETRO-PUBLISH.spec.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { composeRecommendationReporting } from "../../../src/runtime/retrospective-reporting.js";
import type { RecommendationOutcome, RecommendationArtifact } from "../../../src/application/retrospective-recommendations.js";

const scope = { companyId: "company_a", groupId: "group_a" };
function composed() {
  const h = setup();
  const period = { start: "2026-08-24", end: "2026-08-26" };
  h.snapshot.reference = { companyLabel: "Company", groupLabel: "Group", roleLabels: {}, period };
  let latest: RecommendationOutcome<RecommendationArtifact> = { status: "applied", value: h.artifact };
  const dependencies = composeRecommendationReporting({
    processIds: ["work_retrospective"], directory: { getGroupPeriod: async () => period },
    research: { read: async () => h.input }, service: { readLatest: async () => latest },
  });
  const reporting = new CompanyReportingService({ loadGroupSnapshot: async () => h.snapshot }, () => "2026-10-05T12:00:00.000Z", dependencies);
  const build = (recordedBefore?: string) => reporting.buildReport({ ...scope, directory: h.directory, recordedBefore });
  return { ...h, build, setLatest(value: typeof latest) { latest = value; } };
}
describe("Shared retrospective report composition", () => {
  it("SPEC-RETRO-REPORT-COMPOSITION-01: deterministic historical checked report through shared reads", async () => {
    const h = composed();
    const a = await h.build();
    expect(a.client.schemaVersion).toBe("minutka-client-report.v3");
    expect(a.client.recommendations).toHaveLength(1);
    expect(a.client).toEqual((await h.build()).client);
    expect(JSON.stringify(a.client)).not.toMatch(/private_|subjectKey|quote|episodeRefs/);
  });
  it("SPEC-RETRO-REPORT-COMPOSITION-02: missing, draft, stale and foreign data never restore generic approval", async () => {
    const h = composed();
    h.setLatest({ status: "not_found" });
    expect((await h.build()).client).toMatchObject({ recommendations: [], firstSteps: [] });
    h.setLatest({ status: "applied", value: h.artifact });
    h.artifact.candidates[0]!.status = "draft";
    expect((await h.build()).client.deepDive).toHaveLength(1);
    h.setLatest({ status: "failed", code: "validation_error" });
    await expect(h.build()).rejects.toThrow("recommendations_read_blocked");
    h.artifact.scope = { ...scope, groupId: "foreign" };
    h.setLatest({ status: "applied", value: h.artifact });
    await expect(h.build()).rejects.toThrow("cross_scope_artifact");
  });
  it("SPEC-RETRO-REPORT-COMPOSITION-03: correction, supersession and purge invalidate completed-period recommendations", async () => {
    for (const change of ["correction", "supersession", "purge"]) {
      const h = composed();
      if (change === "correction") h.input.evidence.activities[0]!.revision = 2;
      if (change === "supersession") h.input.episodes[0]!.revision++;
      if (change === "purge") h.input.evidence.messages = [];
      expect((await h.build()).client.recommendations).toEqual([]);
    }
  });
  it("SPEC-RETRO-REPORT-COMPOSITION-04: frozen builds explicitly block unsupported revision snapshots", async () => {
    await expect(composed().build("2026-08-25T12:00:00.000Z")).rejects.toThrow("recommendations_snapshot_incompatible");
  });
  it("SPEC-RETRO-REPORT-COMPOSITION-05: no operator decision and stale findings retain publication gates", async () => {
    const h = composed();
    const findings = await h.file();
    expect(await h.publishing.publishClientReport({ ...scope, findings })).toMatchObject({ reason: "operator_decision_required" });
    h.artifact.version++;
    expect(await h.publishing.publishClientReport({ ...scope, findings, operatorDecision: "publish" })).toMatchObject({ reason: "stale_findings" });
  });
});
