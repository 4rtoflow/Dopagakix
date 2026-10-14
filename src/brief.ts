import { spawnSync } from "node:child_process";
import type { SessionFacts } from "./facts.js";
import type { Persona } from "./persona.js";
import { narrationBudget, SENTENCE_LIMIT } from "./script/check.js";
import { creditFor, VoicevoxClient } from "./tts/voicevox.js";
import { formatDateTime } from "./util/time.js";
import { resolveChromium } from "./video/browser.js";

export interface EnvironmentItem {
  name: string;
  /** ok=問題なし / degraded=描画はできるが一部欠ける / missing=描画できない */
  status: "ok" | "degraded" | "missing";
  detail: string;
}

export interface EnvironmentOptions {
  voice: boolean;
  speaker: number;
  voicevoxUrl: string;
  /** クレジット表記の指定(省略時は話者から決める) */
  credit?: string;
  chromium?: string;
  fetch?: typeof fetch;
}

/** 描画に必要なもの(VOICEVOX・Chromium・ffmpeg)がそろっているかを、台本を書く前に確かめる。 */
export async function checkEnvironment(options: EnvironmentOptions): Promise<EnvironmentItem[]> {
  const items: EnvironmentItem[] = [];

  if (!options.voice) {
    items.push({ name: "読み上げ", status: "ok", detail: "なし(字幕のみで作成)" });
  } else {
    try {
      const speakers = await new VoicevoxClient(options.voicevoxUrl, options.fetch).speakers();
      const owner = speakers.find((s) => s.styles.some((style) => style.id === options.speaker));
      const style = owner?.styles.find((s) => s.id === options.speaker);
      items.push(
        owner && style
          ? {
              name: "読み上げ",
              status: "ok",
              detail: `${owner.name}(${style.name}、スタイル ID ${options.speaker})。クレジット表記「${options.credit ?? creditFor(owner.name)}」`,
            }
          : {
              name: "読み上げ",
              status: "missing",
              detail: `話者 ID ${options.speaker} が VOICEVOX エンジンにありません。\`dopagakix speakers\` で一覧を確認してください`,
            },
      );
    } catch {
      items.push({
        name: "読み上げ",
        status: "degraded",
        detail: `VOICEVOX エンジン(${options.voicevoxUrl})に接続できません。このままでは字幕のみの動画になります`,
      });
    }
  }

  try {
    items.push({ name: "Chromium", status: "ok", detail: resolveChromium(options.chromium) });
  } catch (error) {
    items.push({ name: "Chromium", status: "missing", detail: (error as Error).message });
  }

  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const probe = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  items.push(
    probe.status === 0
      ? { name: "ffmpeg", status: "ok", detail: probe.stdout.split("\n")[0]!.trim() }
      : { name: "ffmpeg", status: "missing", detail: `${ffmpeg} を実行できません。ffmpeg をインストールしてください` },
  );
  return items;
}

function formatMinutes(minutes: number | undefined): string {
  if (minutes === undefined) return "不明";
  return minutes < 60 ? `${minutes} 分` : `約 ${(minutes / 60).toFixed(1)} 時間`;
}

const number = (n: number) => n.toLocaleString("ja-JP");

export interface BriefInput {
  facts: SessionFacts;
  /** 台本の書き出し先(表示用のパス) */
  reportFile: string;
  checkCommand: string;
  renderCommand: string;
  digestCommand: string;
  persona?: Persona;
  seconds: number;
  environment: EnvironmentItem[];
  timeZone?: string;
}

/** prepare の出力。エージェントが台本を書くときに参照する情報をまとめる。 */
export function buildBrief(input: BriefInput): string {
  const { facts, persona } = input;
  const added = facts.files.reduce((n, f) => n + f.added, 0);
  const removed = facts.files.reduce((n, f) => n + f.removed, 0);
  const start = formatDateTime(facts.startTime, input.timeZone);
  const end = formatDateTime(facts.endTime, input.timeZone);
  const topFiles = [...facts.files].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 8);
  const missing = input.environment.filter((item) => item.status === "missing");

  const voice = persona
    ? [
        `## 読み上げ文の口調: ${persona.name}`,
        `- ${persona.style}`,
        persona.examples.length > 0 ? `- 例: ${persona.examples.map((e) => `「${e}」`).join("")}` : undefined,
        "- 口調を付けるのは narration だけ。画面の文字(title・headline・summary・items など)は中立に書く。",
        "- 口調に合わせて事実を変えたり、誇張したりしない。",
        persona.endingPattern ? "- 文末は check と render で確かめられる。" : undefined,
      ]
    : ["## 読み上げ文の口調: 丁寧語", "- 指示者に直接報告する丁寧語(です・ます)で書く。"];

  const lines = [
    "# 動画レポートの準備",
    "",
    missing.length > 0
      ? `**描画に必要なものが不足しています(${missing.map((m) => m.name).join("、")})。「環境」を指示者に伝えてください。**\n`
      : undefined,
    "## 手順",
    `1. 台本を書く: ${input.reportFile}`,
    `2. 確かめる: ${input.checkCommand}`,
    `3. 描画する: ${input.renderCommand}`,
    `- 細部を思い出せないときは、ログを振り返る: ${input.digestCommand}`,
    "",
    "## 画面に出る数値(セッションログから自動集計。台本の内容と矛盾させないこと)",
    `- 対象: セッション全体(${facts.sessionId?.slice(0, 8) ?? "ID 不明"}${facts.title ? `「${facts.title}」` : ""})`,
    `- 期間: ${start ? `${start} – ${end}` : "不明"}(作業時間 ${formatMinutes(facts.activeMinutes)}、開始からの経過 ${formatMinutes(facts.elapsedMinutes)})`,
    `- 指示 ${number(facts.userPrompts)} 回 ・ ツール実行 ${number(facts.toolCalls)} 回(コマンド ${number(facts.commandsRun)} 回、うちエラー終了 ${number(facts.commandsFailed)} 回)`,
    `- 変更ファイル ${number(facts.files.length)} 件(+${number(added)} −${number(removed)})`,
    ...topFiles.map((f) => `  - ${f.path}(+${number(f.added)} −${number(f.removed)}${f.created ? "、新規" : ""})`),
    facts.files.length > topFiles.length ? `  - ほか ${facts.files.length - topFiles.length} 件` : undefined,
    "- 変更ファイルと行数は、Edit / Write ツールでの変更だけを数えたもの(シェルのコマンドで変更・削除したファイルは含まない)",
    "",
    ...voice,
    "",
    "## 長さ",
    `- narration は全シーン合計で全角 ${narrationBudget(input.seconds)} 文字程度(約 ${input.seconds} 秒)。1 文は ${SENTENCE_LIMIT} 文字以内、各シーン 1〜3 文。`,
    "",
    "## 環境",
    ...input.environment.map((item) => `- ${item.name}: ${item.status === "ok" ? "" : item.status === "degraded" ? "[注意] " : "[不足] "}${item.detail}`),
    "",
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}
