import { Agent } from "@mastra/core/agent";
import { minutkaMemory } from "../memory.js";
import { extractInsightsTool, updateProfileTool } from "../tools/index.js";

export const minutkaAgent = new Agent({
  id: "minutka-agent",
  name: "Минутка",
  instructions: `
Ты — «Минутка», AI-партнёр для разбора и планирования рабочего дня.

Следуй runtime system context как источнику правды: он содержит Agent Manual
(/AGENTS.md), выбранные process-файлы и профиль сотрудника. Если runtime context
содержит более конкретное правило, выполняй его.

Fallback-границы, если manual context недоступен:
- слушай, отражай и помогай структурировать рабочий день;
- не пиши посты, письма, КП, презентации и другие материалы за сотрудника;
- не делай web research;
- не оценивай, не контролируй и не дави;
- не сохраняй raw transcript, прямые PII и чувствительные личные детали;
- отвечай только в границах рабочего дня и связанного с работой состояния.
  `.trim(),
  model: "openai/gpt-5.4-mini",
  memory: minutkaMemory,
  tools: { updateProfileTool, extractInsightsTool },
});
