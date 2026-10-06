import os from "node:os";
import path from "node:path";
import type { FileChange, SessionFacts } from "../facts.js";
import { formatClock, formatDateTime, zoneLabel } from "../util/time.js";
import { isRecord, str } from "./parse.js";
import type { ParsedSession, SessionEvent } from "./types.js";

type ToolCall = Extract<SessionEvent, { kind: "tool_call" }>;
type ToolResult = Extract<SessionEvent, { kind: "tool_result" }>;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash"]);
/** 結果本文が長いわりに要約の役に立たないツール。失敗したときだけ記載する。 */
const QUIET_RESULT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "ToolSearch",
  "Skill",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

export const DEFAULT_MAX_DIGEST_CHARS = 120_000;

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)} …(${text.length - max} 文字省略)… ${text.slice(text.length - tail)}`;
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ⏎ ").trim();
}

export function displayPath(file: string, cwd?: string): string {
  if (cwd) {
    const rel = path.relative(cwd, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  const home = os.homedir();
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function countLines(text: string): number {
  return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

function countChange(call: ToolCall, detail: unknown): { added: number; removed: number } {
  if (isRecord(detail) && Array.isArray(detail.structuredPatch) && detail.structuredPatch.length > 0) {
    let added = 0;
    let removed = 0;
    for (const hunk of detail.structuredPatch) {
      if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue;
      for (const line of hunk.lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    return { added, removed };
  }
  const input = call.input;
  switch (call.name) {
    case "Write":
      // 既存ファイルの上書きで差分が空なら変更なし
      if (isRecord(detail) && detail.type === "update") return { added: 0, removed: 0 };
      return { added: countLines(str(input.content) ?? (isRecord(detail) ? str(detail.content) : undefined) ?? ""), removed: 0 };
    case "Edit":
      return { added: countLines(str(input.new_string) ?? ""), removed: countLines(str(input.old_string) ?? "") };
    case "MultiEdit": {
      let added = 0;
      let removed = 0;
      for (const edit of Array.isArray(input.edits) ? input.edits : []) {
        if (!isRecord(edit)) continue;
        added += countLines(str(edit.new_string) ?? "");
        removed += countLines(str(edit.old_string) ?? "");
      }
      return { added, removed };
    }
    default:
      return { added: 0, removed: 0 };
  }
}

function recordFileChange(files: Map<string, FileChange>, call: ToolCall, detail: unknown, cwd?: string): void {
  const raw =
    str(call.input.file_path) ?? str(call.input.notebook_path) ?? (isRecord(detail) ? str(detail.filePath) : undefined);
  if (!raw) return;
  const file = displayPath(raw, cwd);
  const { added, removed } = countChange(call, detail);
  const existing = files.get(file);
  if (existing) {
    existing.added += added;
    existing.removed += removed;
    existing.edits += 1;
    return;
  }
  const created = call.name === "Write" && isRecord(detail) && detail.type === "create";
  files.set(file, { path: file, added, removed, edits: 1, created });
}

/** ログから数値や変更ファイルを機械的に集計する。 */
export function collectFacts(session: ParsedSession): SessionFacts {
  const toolCounts: Record<string, number> = {};
  const calls = new Map<string, ToolCall>();
  const files = new Map<string, FileChange>();
  let userPrompts = 0;
  let toolCalls = 0;
  let commandsRun = 0;
  let commandsFailed = 0;

  for (const event of session.events) {
    if (event.kind === "user_prompt") {
      userPrompts++;
    } else if (event.kind === "tool_call") {
      toolCalls++;
      toolCounts[event.name] = (toolCounts[event.name] ?? 0) + 1;
      calls.set(event.id, event);
      if (COMMAND_TOOLS.has(event.name)) commandsRun++;
    } else if (event.kind === "tool_result") {
      const call = calls.get(event.toolUseId);
      if (!call) continue;
      if (COMMAND_TOOLS.has(call.name) && event.isError) commandsFailed++;
      if (EDIT_TOOLS.has(call.name) && !event.isError) recordFileChange(files, call, event.detail, session.cwd);
    }
  }

  const { startTime, endTime } = session;
  const elapsedMinutes =
    startTime && endTime ? Math.max(0, Math.round((Date.parse(endTime) - Date.parse(startTime)) / 60_000)) : undefined;
  const firstPrompt = session.events.find((e) => e.kind === "user_prompt");

  return {
    sessionId: session.sessionId,
    title: session.title ?? (firstPrompt?.kind === "user_prompt" ? clip(oneLine(firstPrompt.text), 40) : undefined),
    project: session.cwd ? path.basename(session.cwd) : undefined,
    cwd: session.cwd,
    branch: session.gitBranch,
    startTime,
    endTime,
    elapsedMinutes,
    userPrompts,
    toolCalls,
    toolCounts,
    commandsRun,
    commandsFailed,
    files: [...files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path)),
    models: session.models,
  };
}

interface Limits {
  prompt: number;
  aiText: number;
  command: number;
  result: number;
}

/** 文字数予算に収まるまで、上から順に簡潔な表記へ切り替える。 */
const LEVELS: Limits[] = [
  { prompt: 6000, aiText: 3000, command: 400, result: 1500 },
  { prompt: 4000, aiText: 1200, command: 240, result: 500 },
  { prompt: 3000, aiText: 600, command: 160, result: 160 },
  { prompt: 2000, aiText: 300, command: 100, result: 0 },
];

interface Line {
  text: string;
  /** 文字数が足りなくても残す行(指示者の発言や最終発言) */
  keep: boolean;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function describeCall(call: ToolCall, limit: number, cwd?: string): string {
  const input = call.input;
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (call.name) {
    case "Bash": {
      const description = str(input.description);
      return `Bash: ${clip(oneLine(str(input.command) ?? ""), limit)}${description ? `(${clip(description, 80)})` : ""}`;
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return `${call.name}: ${file ? displayPath(file, cwd) : "?"}`;
    case "Glob":
    case "Grep":
      return `${call.name}: ${clip(str(input.pattern) ?? "", 120)}${file ? ` (${displayPath(file, cwd)})` : ""}`;
    case "WebSearch":
      return `WebSearch: ${clip(str(input.query) ?? "", 160)}`;
    case "WebFetch":
      return `WebFetch: ${clip(str(input.url) ?? "", 200)}`;
    case "Agent":
    case "Task":
      return `${call.name}(${str(input.subagent_type) ?? "general"}): ${clip(oneLine(str(input.description) ?? str(input.prompt) ?? ""), 200)}`;
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const texts = questions.map((q) => (isRecord(q) ? str(q.question) : undefined)).filter(Boolean);
      return `AskUserQuestion: ${clip(texts.join(" / "), 400)}`;
    }
    default:
      return `${call.name}: ${clip(oneLine(JSON.stringify(input)), Math.min(limit, 200))}`;
  }
}

function describeResult(name: string, result: ToolResult, limits: Limits): string | undefined {
  if (name === "AskUserQuestion") return undefined; // 回答は [ANSWER] として別に出す
  const errorText = () => `[RESULT・エラー] ${clip(oneLine(result.text), 300)}`;
  if (EDIT_TOOLS.has(name) || QUIET_RESULT_TOOLS.has(name)) return result.isError ? errorText() : undefined;
  if (limits.result === 0) return result.isError ? "[RESULT・エラー]" : undefined;
  const body = clip(result.text.trim(), limits.result);
  if (!body) return result.isError ? "[RESULT・エラー]" : "[RESULT] (出力なし)";
  return `[RESULT${result.isError ? "・エラー" : ""}]\n${indent(body)}`;
}

function renderLines(session: ParsedSession, limits: Limits, timeZone?: string): Line[] {
  const calls = new Map<string, ToolCall>();
  // 並列実行されたツールの結果を取り違えないよう、呼び出しに通し番号を振る
  const callNumbers = new Map<string, number>();
  let finalIndex = -1;
  session.events.forEach((event, index) => {
    if (event.kind === "assistant_text") finalIndex = index;
  });

  const lines: Line[] = [];
  session.events.forEach((event, index) => {
    const clock = formatClock(event.time, timeZone);
    const ts = clock ? `${clock} ` : "";
    switch (event.kind) {
      case "user_prompt":
        lines.push({ text: `${ts}[USER] ${clip(event.text, limits.prompt)}`, keep: true });
        break;
      case "user_answer":
        lines.push({
          text: `${ts}[ANSWER] ${event.answers.map((a) => `Q「${a.question}」→ A「${a.answer}」`).join(" / ")}`,
          keep: true,
        });
        break;
      case "interrupt":
        lines.push({ text: `${ts}[USER] (エージェントの作業を中断)`, keep: true });
        break;
      case "compact_summary":
        lines.push({ text: `[ここまでの会話の自動要約] ${clip(event.text, limits.aiText * 2)}`, keep: true });
        break;
      case "assistant_text": {
        const final = index === finalIndex;
        const label = final ? "AI・最終発言" : "AI";
        lines.push({ text: `${ts}[${label}] ${clip(event.text, final ? limits.prompt : limits.aiText)}`, keep: final });
        break;
      }
      case "tool_call":
        calls.set(event.id, event);
        callNumbers.set(event.id, callNumbers.size + 1);
        lines.push({
          text: `${ts}[TOOL#${callNumbers.get(event.id)}] ${describeCall(event, limits.command, session.cwd)}`,
          keep: false,
        });
        break;
      case "tool_result": {
        const name = event.name ?? calls.get(event.toolUseId)?.name ?? "?";
        const text = describeResult(name, event, limits);
        const number = callNumbers.get(event.toolUseId);
        if (text) lines.push({ text: `${ts}${number ? text.replace("[RESULT", `[RESULT#${number}`) : text}`, keep: false });
        break;
      }
    }
  });
  return lines;
}

function renderHeader(facts: SessionFacts, timeZone?: string): string {
  const topTools = Object.entries(facts.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  const shownFiles = facts.files.slice(0, 30).map((f) => {
    const flags = [`+${f.added} -${f.removed}`, f.created ? "新規" : undefined].filter(Boolean).join(", ");
    return `  - ${f.path} (${flags})`;
  });
  if (facts.files.length > shownFiles.length) shownFiles.push(`  - ほか ${facts.files.length - shownFiles.length} 件`);
  const period = facts.startTime
    ? `${formatDateTime(facts.startTime, timeZone)} 〜 ${formatDateTime(facts.endTime, timeZone)}(${zoneLabel(timeZone)}、経過 ${facts.elapsedMinutes ?? "?"} 分)`
    : "不明";

  return [
    "# セッション概要",
    `- タイトル(自動生成): ${facts.title ?? "不明"}`,
    `- プロジェクト: ${facts.project ?? "不明"}${facts.cwd ? `(${facts.cwd})` : ""}`,
    `- ブランチ: ${facts.branch ?? "不明"}`,
    `- 期間: ${period}`,
    `- 指示者の発言: ${facts.userPrompts} 回 / ツール呼び出し: ${facts.toolCalls} 回${topTools ? `(${topTools})` : ""}`,
    `- コマンド実行: ${facts.commandsRun} 回(エラー終了 ${facts.commandsFailed} 回)`,
    `- 変更したファイル: ${facts.files.length} 件`,
    ...shownFiles,
    `- エージェントのモデル: ${facts.models.join(", ") || "不明"}`,
  ].join("\n");
}

function compose(header: string, body: string[]): string {
  return [
    header,
    "",
    "# 時系列ログ",
    "凡例: [USER]=指示者の発言 [ANSWER]=エージェントの質問への指示者の回答 [AI]=エージェントの発言 [TOOL#n]=ツール実行 [RESULT#n]=その実行結果",
    "",
    ...body,
    "",
  ].join("\n");
}

export interface DigestOptions {
  maxChars?: number;
  timeZone?: string;
}

export interface Digest {
  text: string;
  /** 0 が最も詳細。LEVELS.length は行の間引きまで行ったことを示す。 */
  level: number;
  omittedLines: number;
}

/**
 * LLM に渡すダイジェストを作る。文字数予算を超える場合は、ツール出力から順に削り、
 * 最後は古い側の重要度の低い行を間引く(指示者の発言・回答・最終発言は残す)。
 */
export function buildDigest(session: ParsedSession, facts: SessionFacts, options: DigestOptions = {}): Digest {
  const maxChars = options.maxChars ?? DEFAULT_MAX_DIGEST_CHARS;
  const header = renderHeader(facts, options.timeZone);

  let lines: Line[] = [];
  for (const [level, limits] of LEVELS.entries()) {
    lines = renderLines(session, limits, options.timeZone);
    const text = compose(
      header,
      lines.map((l) => l.text),
    );
    if (text.length <= maxChars) return { text, level, omittedLines: 0 };
  }

  const keepTail = 40;
  const removed = lines.map(() => false);
  let size = compose(
    header,
    lines.map((l) => l.text),
  ).length;
  let omittedLines = 0;
  for (let i = 0; i < lines.length - keepTail && size > maxChars; i++) {
    if (lines[i]!.keep) continue;
    removed[i] = true;
    size -= lines[i]!.text.length + 1;
    omittedLines++;
  }

  const body: string[] = [];
  let run = 0;
  lines.forEach((line, i) => {
    if (removed[i]) {
      run++;
      return;
    }
    if (run > 0) body.push(`…(中略: ${run} 行)…`);
    run = 0;
    body.push(line.text);
  });

  let text = compose(header, body);
  if (text.length > maxChars) {
    // 残すべき行だけでも予算を超える場合は、古い側を切り落とす
    const room = Math.max(0, maxChars - header.length - 64);
    const joined = body.join("\n");
    text = compose(header, ["…(前半を省略)…", joined.slice(joined.length - room)]);
  }
  return { text, level: LEVELS.length, omittedLines };
}
