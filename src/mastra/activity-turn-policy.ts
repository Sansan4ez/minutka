import type { CollectActivitiesInput } from "../contracts/minutka-activity.js";

const activityRepairSignals = [
  /(?:^|[^\p{L}\p{N}_])(?:исправ(?:ь|ьте|ить|ляю)|поправ(?:ь|ьте|ить)|скорректир[\p{L}\p{N}_]*|уточн(?:ю|ение|ить|яю)|ошиб[\p{L}\p{N}_]*|неверн[\p{L}\p{N}_]*|неправильн[\p{L}\p{N}_]*|точнее|вернее)(?=$|[^\p{L}\p{N}_])/iu,
  /\b(?:дубликат[\p{L}\p{N}_]*|дубл[\p{L}\p{N}_]*|запис[\p{L}\p{N}_]*\s+дважды|это\s+(?:та|тот|то)\s+же)\b/iu,
  /\b(?:correct|correction|clarif(?:y|ication)|fix|wrong|mistake|duplicate)\b/iu,
];

const facetEvidence = {
  system: {
    positive: /(?:битрикс[\p{L}\p{N}_]*|bitrix[\p{L}\p{N}_]*|1[сc](?=$|[^\p{L}\p{N}_])|excel\b|spreadsheet[\p{L}\p{N}_]*|таблиц[\p{L}\p{N}_]*|почт[\p{L}\p{N}_]*|e-?mail\b|crm\b|мессендж[\p{L}\p{N}_]*|telegram\b|телеграм[\p{L}\p{N}_]*|whatsapp\b|вотсап[\p{L}\p{N}_]*|трекер[\p{L}\p{N}_]*|телефон(?:ия|у|ом)?|тендерн[\p{L}\p{N}_]*\s+платформ[\p{L}\p{N}_]*|логистическ[\p{L}\p{N}_]*\s+систем[\p{L}\p{N}_]*|учебн[\p{L}\p{N}_]*\s+платформ[\p{L}\p{N}_]*|на\s+бумаг[\p{L}\p{N}_]*|устн[\p{L}\p{N}_]*|внутренн[\p{L}\p{N}_]*\s+(?:систем|платформ|программ)[\p{L}\p{N}_]*|самописн[\p{L}\p{N}_]*\s+(?:систем|платформ|программ)[\p{L}\p{N}_]*|(?:в|через|с\s+помощью)\s+(?:систем|платформ|сервис|приложен|программ)[\p{L}\p{N}_]*)/iu,
    absent: /\b(?:(?:систем|платформ|канал|программ|приложен)[\p{L}\p{N}_]*\s+(?:и\s+\w+\s+)?не\s+(?:назыв|указ|упомин)[\p{L}\p{N}_]*|без\s+(?:названн\w+\s+)?(?:систем|платформ|канал)[\p{L}\p{N}_]*)\b/iu,
  },
  routinePattern: {
    positive: /(?:препятств[\p{L}\p{N}_]*|помех[\p{L}\p{N}_]*|трени[\p{L}\p{N}_]*|мешал[\p{L}\p{N}_]*|помешал[\p{L}\p{N}_]*|проблем[\p{L}\p{N}_]*|сложност[\p{L}\p{N}_]*|задерж[\p{L}\p{N}_]*|ждал[\p{L}\p{N}_]*|ожидани[\p{L}\p{N}_]*|вручную|ручн[\p{L}\p{N}_]*|переключ[\p{L}\p{N}_]*|неясн[\p{L}\p{N}_]*|непонятн[\p{L}\p{N}_]*|застрял[\p{L}\p{N}_]*|заблокир[\p{L}\p{N}_]*|слишком\s+много\s+(?:встреч|созвон)[\p{L}\p{N}_]*|friction\b|obstacle\b|blocker\b|blocked\b|waiting\b|manual\b)/iu,
    absent: /(?:(?:препятств|помех|проблем|сложност)[\p{L}\p{N}_]*\s+(?:и\s+\w+\s+)?не\s+(?:назыв|указ|упомин)[\p{L}\p{N}_]*|без\s+(?:препятств|помех|проблем|сложност)[\p{L}\p{N}_]*|ничего\s+не\s+мешал[\p{L}\p{N}_]*|(?:препятств|проблем)[\p{L}\p{N}_]*\s+не\s+был[\p{L}\p{N}_]*)/iu,
  },
  automationCandidate: {
    positive: /(?:автоматиз[\p{L}\p{N}_]*|автоматизац[\p{L}\p{N}_]*|бот[\p{L}\p{N}_]*\s+(?:может|мог|сможет)|ии\s+(?:может|мог|сможет)|ai\s+(?:can|could)|automation\b|automate[\p{L}\p{N}_]*)/iu,
    absent: /\b(?:(?:автоматизац|автоматиз)[\p{L}\p{N}_]*\s+(?:и\s+\w+\s+)?не\s+(?:назыв|указ|упомин|предлаг)[\p{L}\p{N}_]*|без\s+(?:идеи\s+)?автоматизац[\p{L}\p{N}_]*)\b/iu,
  },
  energyStressMarker: {
    positive: /(?:энерги[\p{L}\p{N}_]*|сил[\p{L}\p{N}_]*|устал[\p{L}\p{N}_]*|утом[\p{L}\p{N}_]*|перегруз[\p{L}\p{N}_]*|раздраж[\p{L}\p{N}_]*|фрустр[\p{L}\p{N}_]*|стресс[\p{L}\p{N}_]*|напряж[\p{L}\p{N}_]*|фокус[\p{L}\p{N}_]*|сосредоточ[\p{L}\p{N}_]*|застрял[\p{L}\p{N}_]*|заблокир[\p{L}\p{N}_]*|спокойн[\p{L}\p{N}_]*|нормальн[\p{L}\p{N}_]*\s+(?:себя|чувств)|fatigue\b|tired\b|overload[\p{L}\p{N}_]*|frustrat[\p{L}\p{N}_]*|stress[\p{L}\p{N}_]*|focus\b|energy\b|calm\b)/iu,
    absent: /\b(?:(?:энерги|стресс|самочувств|эмоци)[\p{L}\p{N}_]*\s+(?:и\s+\w+\s+)?не\s+(?:назыв|указ|упомин|описы)[\p{L}\p{N}_]*|без\s+(?:оценки\s+)?(?:энерги|стресс|самочувств)[\p{L}\p{N}_]*)\b/iu,
  },
} as const;

/**
 * Correction tools are authority-bearing local repair actions. Keep them out of
 * an ordinary factual turn unless the employee explicitly signals repair.
 */
export function hasExplicitActivityRepairSignal(text: string): boolean {
  return activityRepairSignals.some((pattern) => pattern.test(text));
}

/**
 * Preserve the LLM extraction plane while enforcing its evidence boundary:
 * optional facet families absent from the employee's current account cannot be
 * materialized as guessed closed values. The factual row itself is preserved.
 */
export function constrainActivityFacetsToSource(
  text: string,
  input: CollectActivitiesInput,
): CollectActivitiesInput {
  const supported = {
    system: hasFacetEvidence(text, facetEvidence.system),
    routinePattern: hasFacetEvidence(text, facetEvidence.routinePattern),
    automationCandidate: hasFacetEvidence(text, facetEvidence.automationCandidate),
    energyStressMarker: hasFacetEvidence(text, facetEvidence.energyStressMarker),
  };

  return {
    activities: input.activities.map((activity) => {
      const constrained = { ...activity };
      if (!supported.system) delete constrained.system;
      if (!supported.routinePattern) delete constrained.routinePattern;
      if (!supported.automationCandidate) delete constrained.automationCandidate;
      if (!supported.energyStressMarker) delete constrained.energyStressMarker;
      return constrained;
    }),
  };
}

function hasFacetEvidence(
  text: string,
  patterns: { positive: RegExp; absent: RegExp },
): boolean {
  return !patterns.absent.test(text) && patterns.positive.test(text);
}
