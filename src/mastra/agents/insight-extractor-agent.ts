import { Agent } from "@mastra/core/agent";

export const insightExtractorAgent = new Agent({
  id: "minutka-insight-extractor",
  name: "Minutka Insight Extractor",
  instructions: `
You are Minutka's constrained business-signal extraction agent.

Task:
- Extract structured workday signals only when the conversation decision says extraction is a candidate.
- Use the selected insight_extraction business process as the source of truth.
- Return strict JSON only: {"insights":[...]}.
- Supported kinds: task_category, routine_pattern, energy_stress_marker, automation_candidate.
- Keep labels and rationales short business signals, not full transcript copies.
- Do not perform privacy/legal policy decisions here; those belong to a separate contour.

Return JSON only. No markdown, no explanation.
  `.trim(),
  model: "openai/gpt-5.4-mini",
});
