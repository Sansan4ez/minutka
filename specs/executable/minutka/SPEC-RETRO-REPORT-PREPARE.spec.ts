import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { RetrospectiveRecommendationService, createRecommendationResearchRead } from "../../../src/application/retrospective-recommendations.js";
import { createRecommendationParticipants } from "../../../src/application/recommendation-participants.js";
import { runCompanyReportCommand } from "../../../src/runtime/company-report-command.js";
import type { Participant } from "../../../src/domain/employee.js";

const scope = { companyId: "company", groupId: "group" };
function setup() {
  const clock = { now: () => "2026-08-26T12:00:00.000Z" };
  const contents = createInMemoryArtifactContentStore(clock);
  const bodies = new Map<string, string>();
  const put = contents.put.bind(contents);
  contents.put = async input => {
    const chunks: Buffer[] = [];
    for await (const chunk of input.openStream()) chunks.push(Buffer.from(chunk));
    bodies.set(input.contentDigest, Buffer.concat(chunks).toString());
    return put(input);
  };
  const artifacts = createInMemoryArtifactStore({ clock, contentStore: contents, limits: { maximumBytes: 1000000, timeoutMs: 1000 } });
  let calls = 0;
  let reads = 0;
  let failGeneration = false;
  const deps = { contents, artifacts, research: { async read() { reads++; return { scope, episodes: [], evidence: { messages: [], activities: [] } }; } },
    generator: { version: "fake/v1", async generate() { calls++; if (failGeneration) throw new Error("private secret"); return []; } },
    async loadContent(url: string) { return bodies.get(new URL(url).pathname.split("/").at(-1)!)!; } };
  const service = new RetrospectiveRecommendationService(deps);
  let output = "";
  const command = async (argv: string[], recommendations = service) => {
    output = "";
    await runCompanyReportCommand([...argv, "--company", scope.companyId, "--group", scope.groupId], {
      recommendations, reporting: { async buildReport() { throw new Error("unused"); } }, checkLlm: async () => { throw new Error("unused"); },
    }, text => { output += text; });
    return JSON.parse(output);
  };
  return { command, service, deps, calls: () => calls, reads: () => reads, output: () => output, fail: () => { failGeneration = true; } };
}

describe("Operator recommendation preparation", () => {
  it("SPEC-RETRO-REPORT-PREPARE-01: prepare durably saves version one and emits metadata only", async () => {
    const f = setup();
    const result = await f.command(["prepare-recommendations"]);
    expect(result).toEqual({ status: "applied", artifactId: expect.any(String), version: 1 });
    expect(f.calls()).toBe(1);
    expect(await f.service.read(scope, result.artifactId)).toMatchObject({ status: "applied", value: { version: 1 } });
    expect(f.output()).not.toMatch(/episodes|subjectKey|quote|refs/);
  });
  it("SPEC-RETRO-REPORT-PREPARE-02: operator check rereads evidence, creates immutable version and refuses foreign lookup", async () => {
    const f = setup();
    const draft = await f.command(["prepare-recommendations"]);
    const directory = await mkdtemp(join(tmpdir(), "recommendation-review-"));
    try {
      const file = join(directory, "decisions.json");
      await writeFile(file, JSON.stringify({ operatorId: "operator", decisions: {} }));
      const before = f.reads();
      expect(await f.command(["check-recommendations", "--artifact", draft.artifactId, "--decisions", file])).toMatchObject({ status: "applied", version: 2 });
      expect(f.reads()).toBeGreaterThan(before);
      expect(f.calls()).toBe(1);
      const count = (await f.deps.artifacts.list((await import("../../../src/application/retrospective-recommendations.js")).recommendationArtifactOwner(scope))).length;
      expect(await f.service.read({ ...scope, groupId: "foreign" }, draft.artifactId)).toEqual({ status: "not_found" });
      expect(count).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("SPEC-RETRO-REPORT-PREPARE-03: restart reloads latest and recompute creates a new draft version", async () => {
    const f = setup();
    const draft = await f.command(["prepare-recommendations"]);
    const restarted = new RetrospectiveRecommendationService(f.deps);
    expect(await restarted.readLatest(scope)).toMatchObject({ status: "applied", value: { artifactId: draft.artifactId } });
    const next = await f.command(["recompute-recommendations", "--artifact", draft.artifactId], restarted);
    expect(next).toMatchObject({ status: "applied", version: 2 });
    expect(f.calls()).toBe(2);
    expect(await restarted.readLatest(scope)).toMatchObject({ status: "applied", value: { previousArtifactId: draft.artifactId, version: 2 } });
  });
  it("SPEC-RETRO-REPORT-PREPARE-04: discovery traverses pages/all owner threads and detects incomplete sources", async () => {
    const participants = Array.from({ length: 101 }, (_, i) => ({ ...scope, employeeId: `e${i}`, subjectKey: `s${i}`, createdAt: "2026-08-26T12:00:00.000Z" }) as Participant);
    const profiles = { async listParticipants(input: { after?: unknown }) { return input.after ? participants.slice(100) : participants.slice(0, 100); } };
    const threads = { async listOwnerThreads() { return ["one", "two"]; } };
    const discover = createRecommendationParticipants(profiles, threads);
    expect(await discover(scope)).toHaveLength(202);
    await expect(createRecommendationParticipants({ async listParticipants() { return participants.slice(0, 100); } }, threads)(scope)).rejects.toThrow("participant_discovery_incomplete");
    await expect(createRecommendationParticipants({ async listParticipants() { return [{ ...participants[0]!, groupId: "foreign" }]; } }, threads)(scope)).rejects.toThrow();
    const read = createRecommendationResearchRead({ participants: discover, episodes: { async readEpisodes() { return { status: "applied", value: Array(100).fill({}) }; } }, evidence: { async listRoutineEvidence() { return { messages: [], activities: [] }; } } });
    await expect(read.read(scope)).rejects.toThrow("episode_read_limit");
  });
  it("SPEC-RETRO-REPORT-PREPARE-05: read/storage/generation errors are safe and never claim durable success", async () => {
    const f = setup();
    f.fail();
    expect(await f.command(["prepare-recommendations"])).toEqual({ status: "failed", code: "generation_error" });
    expect(f.output()).not.toContain("private secret");
    const g = setup();
    g.deps.artifacts.save = async () => { throw new Error("private storage secret"); };
    expect(await g.command(["prepare-recommendations"])).toEqual({ status: "failed", code: "storage_error" });
    expect(await g.service.read(scope, "missing")).toEqual({ status: "not_found" });
    expect(g.calls()).toBe(1);
  });
});
