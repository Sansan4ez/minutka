import type { UserProfile } from "../domain/employee.js";
import type { WorkPolicyDecision } from "../domain/work-policy.js";

export type WorkPolicy = {
  evaluate(input: {
    employeeId: string;
    threadId: string;
    text: string;
    profile?: UserProfile;
  }): WorkPolicyDecision;
};

export function createDefaultWorkPolicy(): WorkPolicy {
  return {
    evaluate(input) {
      const text = normalize(input.text);

      if (
        includesAny(text, [
          "напиши пост",
          "сделай пост",
          "пост для соцсети",
          "пост в соцсети",
          "пост для социальной сети",
          "напиши письмо",
          "составь письмо",
          "составь кп",
          "коммерческое предложение",
          "сделай презентацию за меня",
        ])
      ) {
        const decision: WorkPolicyDecision = {
          relevance: "out_of_scope",
          allowedForAgent: false,
          shouldExtractInsights: false,
          reason: "content_generation_request",
        };
        return {
          ...decision,
          refusalResponse: buildWorkBoundaryResponse(decision, input.profile),
        };
      }

      if (
        includesAny(text, [
          "найди в интернете",
          "проверь сайт",
          "собери research",
          "собери ресерч",
          "исследуй рынок в интернете",
        ])
      ) {
        const decision: WorkPolicyDecision = {
          relevance: "out_of_scope",
          allowedForAgent: false,
          shouldExtractInsights: false,
          reason: "web_research_request",
        };
        return {
          ...decision,
          refusalResponse: buildWorkBoundaryResponse(decision, input.profile),
        };
      }

      if (
        includesAny(text, [
          "научи пользоваться chatgpt",
          "научи пользоваться чатгпт",
          "научи пользоваться нейросетью",
          "обучи меня chatgpt",
        ])
      ) {
        const decision: WorkPolicyDecision = {
          relevance: "out_of_scope",
          allowedForAgent: false,
          shouldExtractInsights: false,
          reason: "ai_training_request",
        };
        return {
          ...decision,
          refusalResponse: buildWorkBoundaryResponse(decision, input.profile),
        };
      }

      if (
        includesAny(text, [
          "сегодня приоритет",
          "приоритет",
          "план",
          "отчёт",
          "отчет",
          "звонк",
          "созвон",
          "встреч",
          "не успел",
          "не успела",
          "не продвинулся",
          "заблокирован",
          "устал",
          "устала",
          "выгорел",
          "сил нет",
          "задач",
          "рабоч",
        ])
      ) {
        return {
          relevance: "work_related",
          allowedForAgent: true,
          shouldExtractInsights: true,
          reason: includesAny(text, ["приоритет", "план"])
            ? "planning_or_prioritization"
            : includesAny(text, ["устал", "устала", "выгорел", "сил нет"])
              ? "work_emotional_state"
              : "workday_reflection",
        };
      }

      return {
        relevance: "ambiguous",
        allowedForAgent: true,
        shouldExtractInsights: false,
        reason: "unknown",
      };
    },
  };
}

export function buildWorkBoundaryResponse(
  decision: WorkPolicyDecision,
  profile?: UserProfile,
): string {
  const persona = profile?.persona ?? "support";
  if (persona === "efficiency") {
    return "Я не пишу посты или рабочие материалы за тебя. Могу помочь быстро разобрать рабочий день: что сейчас главный приоритет, что мешает и какой следующий шаг?";
  }

  if (decision.reason === "web_research_request") {
    return "Я не ищу информацию в интернете за тебя. Зато могу бережно разложить рабочий день: что важно, что забирает силы и с какого маленького шага начать?";
  }

  return "Я не пишу посты и материалы за тебя. Зато могу помочь бережно разложить рабочий день: что важно, что забирает силы и с какого маленького шага начать?";
}

function normalize(text: string) {
  return text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}
