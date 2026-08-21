import type { PilotStatusData } from "./pilot-status.js";

export const pilotStatusDataMarker = "__PILOT_STATUS_DATA__";

/** Template and application data stay independent: the use-case never knows HTML structure or styling. */
export function renderPilotStatusHtml(template: string, data: PilotStatusData): string {
  const matches = template.split(pilotStatusDataMarker).length - 1;
  if (matches !== 1) throw new Error(`pilot-status template must contain exactly one ${pilotStatusDataMarker} marker`);
  return template.replace(pilotStatusDataMarker, safeInlineJson(data));
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
