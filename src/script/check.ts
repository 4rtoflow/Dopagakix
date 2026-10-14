import type { SessionFacts } from "../facts.js";
import { checkEndings, type Persona } from "../persona.js";
import { LIMITS } from "./normalize.js";
import type { VideoScript } from "./schema.js";

/** 読み上げ文 1 文の長さの目安(全角)。字幕 1 枚に収まる */
export const SENTENCE_LIMIT = 35;
/** これを超えたら警告する(字幕が 2 枚に分かれる) */
const SENTENCE_WARN = 45;
/** 1 シーンの文の数の上限の目安 */
const SENTENCES_PER_SCENE = 3;

/**
 * 読み上げ文の合計文字数の目安。VOICEVOX ずんだもんの実測で、話速 1.25 で約 7.3 文字/秒。
 * シーン切り替えや文間の間(合計 8 秒程度)を除いた時間に収まるよう、少なめ(6 文字/秒)に見積もる。
 */
export function narrationBudget(targetSeconds: number): number {
  return Math.max(120, Math.round((targetSeconds - 8) * 6));
}

/** 読み上げると不自然になる表記 */
const HARD_TO_READ: Array<[RegExp, string]> = [
  [/https?:\/\//i, "URL"],
  [/`|\w_\w|\w\(\)|[{}<>[\]=\\|$]/, "コード・記号"],
  [/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|rb|go|rs|java|kt|swift|cpp|hpp|cs|php|css|scss|html|vue|svelte|ya?ml|toml|sh|sql|lock)\b/i, "ファイル名"],
  [/\b[a-z][\w.-]*\/[\w./-]*[a-z]/, "パス"],
  [/\p{Extended_Pictographic}/u, "絵文字"],
];

/** ファイル名に見えるが、製品名としてそのまま読んでよいもの */
const PRODUCT_NAMES = /\b(?:node|next|nuxt|vue|three|chart|solid|ember|express|alpine|d3)\.js\b/gi;

function hardToRead(text: string): string[] {
  const target = text.replace(PRODUCT_NAMES, "");
  return HARD_TO_READ.filter(([pattern]) => pattern.test(target)).map(([, label]) => label);
}

/** 画面の文字の長さの目安(全角)。超えた分は縮小して収めるため、大きく超えたときだけ警告する */
const SCREEN_LIMITS = { title: 20, headline: 40, summary: 60, item: 28, label: 24, decisionTitle: 24, detail: 50 } as const;

export interface ScriptIssue {
  /** 台本(JSON)の中の位置。例: work.narration[1] */
  at: string;
  message: string;
}

export interface ScriptCheck {
  issues: ScriptIssue[];
  /** 読み上げ文の数と合計文字数 */
  sentences: number;
  narrationChars: number;
  /** 合計文字数の目安 */
  budget: number;
}

export interface CheckOptions {
  /** 読み上げ文の口調(指定すると文末を確かめる) */
  persona?: Persona;
  /** セッションログから集計した事実(あれば数値との食い違いも確かめる) */
  facts?: SessionFacts;
  /** 動画の長さの目安(秒) */
  seconds: number;
}

function narrations(script: VideoScript): Array<{ at: string; lines: string[] }> {
  return [
    { at: "opening.narration", lines: script.opening.narration },
    { at: "request.narration", lines: script.request.narration },
    { at: "work.narration", lines: script.work.narration },
    { at: "verification.narration", lines: script.verification.narration },
    { at: "decisions.narration", lines: script.decisions.narration },
    { at: "next_steps.narration", lines: script.next_steps.narration },
  ];
}

/** 画面に出る文字(口調を付けない部分) */
function screenTexts(script: VideoScript): Array<{ at: string; text: string; limit: number }> {
  return [
    { at: "title", text: script.title, limit: SCREEN_LIMITS.title },
    { at: "headline", text: script.headline, limit: SCREEN_LIMITS.headline },
    { at: "request.summary", text: script.request.summary, limit: SCREEN_LIMITS.summary },
    ...script.work.items.map((text, i) => ({ at: `work.items[${i}]`, text, limit: SCREEN_LIMITS.item })),
    ...script.verification.items.map((item, i) => ({
      at: `verification.items[${i}].label`,
      text: item.label,
      limit: SCREEN_LIMITS.label,
    })),
    ...script.decisions.items.flatMap((item, i) => [
      { at: `decisions.items[${i}].title`, text: item.title, limit: SCREEN_LIMITS.decisionTitle },
      { at: `decisions.items[${i}].detail`, text: item.detail, limit: SCREEN_LIMITS.detail },
    ]),
    ...script.next_steps.items.map((text, i) => ({ at: `next_steps.items[${i}]`, text, limit: SCREEN_LIMITS.item })),
  ];
}

/**
 * エージェントが書いた台本を確かめる。描画はできるが見づらくなる点や、
 * 事実との食い違いが疑われる点を警告として返す(形式の誤りは読み込み時に検出する)。
 */
export function checkScript(script: VideoScript, options: CheckOptions): ScriptCheck {
  const issues: ScriptIssue[] = [];
  const { persona, facts } = options;
  let sentences = 0;
  let narrationChars = 0;

  for (const { at, lines } of narrations(script)) {
    const spoken = lines.map((line) => line.trim()).filter(Boolean);
    sentences += spoken.length;
    narrationChars += spoken.reduce((n, line) => n + line.length, 0);
    if (spoken.length === 0) {
      issues.push({ at, message: "読み上げ文がありません。このシーンは読み上げも字幕もなくなります。" });
    } else if (spoken.length > SENTENCES_PER_SCENE) {
      issues.push({ at, message: `${spoken.length} 文あります。各シーン 1〜${SENTENCES_PER_SCENE} 文にしてください。` });
    }
    lines.forEach((line, i) => {
      const text = line.trim();
      if (!text) return;
      if (text.length > SENTENCE_WARN) {
        issues.push({
          at: `${at}[${i}]`,
          message: `${text.length} 文字あります(1 文 ${SENTENCE_LIMIT} 文字以内が目安)。字幕が分かれます:「${text}」`,
        });
      }
      const hard = hardToRead(text);
      if (hard.length > 0) {
        issues.push({ at: `${at}[${i}]`, message: `読み上げにくい表記(${hard.join("・")})があります。言い換えてください:「${text}」` });
      }
      if (persona && checkEndings([text], persona).misses.length > 0) {
        issues.push({ at: `${at}[${i}]`, message: `${persona.name}の口調の文末になっていません:「${text}」` });
      }
    });
  }

  for (const { at, text, limit } of screenTexts(script)) {
    const length = text.trim().length;
    if (length > Math.round(limit * 1.25)) {
      issues.push({ at, message: `${length} 文字あります(目安 ${limit} 文字以内)。文字が小さく縮小されます:「${text.trim()}」` });
    }
    if (persona?.endingPattern && new RegExp(persona.endingPattern).test(text.trim())) {
      issues.push({ at, message: `画面の文字には口調を付けず、中立に書いてください:「${text.trim()}」` });
    }
  }

  const counts: Array<[string, number, number]> = [
    ["work.items", script.work.items.length, LIMITS.work],
    ["verification.items", script.verification.items.length, LIMITS.verification],
    ["decisions.items", script.decisions.items.length, LIMITS.decisions],
    ["next_steps.items", script.next_steps.items.length, LIMITS.nextSteps],
  ];
  for (const [at, count, limit] of counts) {
    if (count > limit) issues.push({ at, message: `${count} 件あります。表示されるのは先頭の ${limit} 件だけです。` });
  }

  const budget = narrationBudget(options.seconds);
  if (narrationChars > budget * 1.3) {
    issues.push({
      at: "narration",
      message: `読み上げ文が合計 ${narrationChars} 文字あり、目安の ${budget} 文字(約 ${options.seconds} 秒)を大きく超えています。話速が上がるか、動画が長くなります。`,
    });
  }

  // 自己報告の偏り(成果の誇張)を機械的に拾えるものだけ確かめる
  if (script.status === "completed" && script.verification.items.some((item) => item.result === "fail")) {
    issues.push({ at: "status", message: "completed(完了)ですが、検証結果に fail(失敗)があります。status か検証結果を見直してください。" });
  }
  if (script.status === "blocked" && script.decisions.items.length === 0) {
    issues.push({ at: "decisions.items", message: "status が blocked(判断待ち)なのに、判断してほしいことが書かれていません。" });
  }
  if (facts && facts.commandsRun === 0 && script.verification.items.some((item) => item.result !== "not_run")) {
    issues.push({
      at: "verification.items",
      message: "セッションログにコマンドの実行記録がないのに、検証結果に pass / fail があります。実行していない検証は not_run にしてください。",
    });
  }

  return { issues, sentences, narrationChars, budget };
}
