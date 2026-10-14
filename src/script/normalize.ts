import { redactSecrets } from "../redact.js";
import type { VideoScript } from "./schema.js";

/** 画面に表示できる項目数 */
export const LIMITS = { work: 5, verification: 4, decisions: 3, nextSteps: 3 } as const;

function clean(text: string): string {
  return redactSecrets(text.replace(/\s+/g, " ").trim()).text;
}

function cleanLines(lines: string[]): string[] {
  return lines.map(clean).filter(Boolean);
}

/**
 * 台本を表示用に整える。エージェントが書いた台本にも、手で編集した script.json にも使う。
 * 件数の上限を超えた項目は切り捨て、秘匿情報の取りこぼしをもう一度マスクする。
 */
export function normalizeScript(script: VideoScript): VideoScript {
  return {
    title: clean(script.title),
    status: script.status,
    headline: clean(script.headline),
    opening: { narration: cleanLines(script.opening.narration) },
    request: { summary: clean(script.request.summary), narration: cleanLines(script.request.narration) },
    work: {
      items: cleanLines(script.work.items).slice(0, LIMITS.work),
      narration: cleanLines(script.work.narration),
    },
    verification: {
      items: script.verification.items
        .map((item) => ({ label: clean(item.label), result: item.result }))
        .filter((item) => item.label)
        .slice(0, LIMITS.verification),
      narration: cleanLines(script.verification.narration),
    },
    decisions: {
      items: script.decisions.items
        .map((item) => ({ title: clean(item.title), detail: clean(item.detail) }))
        .filter((item) => item.title)
        .slice(0, LIMITS.decisions),
      narration: cleanLines(script.decisions.narration),
    },
    next_steps: {
      items: cleanLines(script.next_steps.items).slice(0, LIMITS.nextSteps),
      narration: cleanLines(script.next_steps.narration),
    },
  };
}
