import { describe, expect, it } from "vitest";
import { buildBrief, checkEnvironment, type EnvironmentItem } from "../src/brief.js";
import type { SessionFacts } from "../src/facts.js";
import { ZUNDAMON } from "../src/persona.js";

const facts: SessionFacts = {
  sessionId: "4e4e81c0-e918-5c46-a46a-3db330e7f5d9",
  title: "ログイン画面の修正",
  startTime: "2026-10-13T01:00:00.000Z",
  endTime: "2026-10-13T02:30:00.000Z",
  elapsedMinutes: 90,
  activeMinutes: 42,
  userPrompts: 3,
  toolCalls: 120,
  toolCounts: {},
  commandsRun: 40,
  commandsFailed: 2,
  files: Array.from({ length: 10 }, (_, i) => ({ path: `src/file-${i}.ts`, added: i * 10, removed: i, edits: 1, created: i === 9 })),
  models: ["claude-opus-5-5"],
};

const ok: EnvironmentItem[] = [
  { name: "読み上げ", status: "ok", detail: "VOICEVOX:ずんだもん(ノーマル、スタイル ID 3)" },
  { name: "Chromium", status: "ok", detail: "/usr/bin/chromium" },
];

const input = {
  facts,
  reportFile: "dopagakix-out/x/report.json",
  checkCommand: "dopagakix check dopagakix-out/x/report.json --session 4e4e81c0",
  renderCommand: "dopagakix render dopagakix-out/x/report.json --session 4e4e81c0",
  digestCommand: "dopagakix digest --session 4e4e81c0 -o dopagakix-out/x/digest.md",
  seconds: 60,
  environment: ok,
  timeZone: "Asia/Tokyo",
};

describe("buildBrief", () => {
  it("手順・画面に出る数値・口調・長さ・環境をまとめる", () => {
    const text = buildBrief({ ...input, persona: ZUNDAMON });
    expect(text).toContain("1. 台本を書く: dopagakix-out/x/report.json");
    expect(text).toContain("3. 描画する: dopagakix render dopagakix-out/x/report.json --session 4e4e81c0");
    expect(text).toContain("期間: 2026/10/13 10:00 – 2026/10/13 11:30(作業時間 42 分、開始からの経過 約 1.5 時間)");
    expect(text).toContain("指示 3 回 ・ ツール実行 120 回(コマンド 40 回、うちエラー終了 2 回)");
    // 変更の大きい順に 8 件
    expect(text).toContain("  - src/file-9.ts(+90 −9、新規)");
    expect(text).toContain("  - ほか 2 件");
    expect(text).toContain("## 読み上げ文の口調: ずんだもん");
    expect(text).toContain("全角 312 文字程度");
    expect(text).not.toContain("不足しています");
  });

  it("口調がなければ丁寧語、足りないものがあれば冒頭で知らせる", () => {
    const text = buildBrief({ ...input, environment: [...ok, { name: "ffmpeg", status: "missing", detail: "なし" }] });
    expect(text).toContain("## 読み上げ文の口調: 丁寧語");
    expect(text).toMatch(/^# 動画レポートの準備\n\n\*\*描画に必要なものが不足しています\(ffmpeg\)/);
    expect(text).toContain("- ffmpeg: [不足] なし");
  });
});

describe("checkEnvironment", () => {
  const engine = (async () =>
    Response.json([{ name: "ずんだもん", speaker_uuid: "z", styles: [{ name: "ノーマル", id: 3 }] }])) as typeof fetch;
  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const base = { voicevoxUrl: "http://127.0.0.1:59999", chromium: "/nonexistent/chrome" };

  it("VOICEVOX の状態で、読み上げの可否を判断する", async () => {
    const voice = async (options: { voice: boolean; speaker: number; fetch: typeof fetch }) =>
      (await checkEnvironment({ ...base, ...options })).find((item) => item.name === "読み上げ");
    expect(await voice({ voice: true, speaker: 3, fetch: engine })).toMatchObject({
      status: "ok",
      detail: "ずんだもん(ノーマル、スタイル ID 3)。クレジット表記「VOICEVOX:ずんだもん」",
    });
    // 読み上げは必須。接続できなければ不足として扱い、対処を示す
    expect(await voice({ voice: true, speaker: 3, fetch: unreachable })).toMatchObject({
      status: "missing",
      detail: expect.stringMatching(/接続できません。エンジンを起動してから[\s\S]*DOPAGAKIX_VOICEVOX_START/),
    });
    expect(await voice({ voice: true, speaker: 13, fetch: engine })).toMatchObject({ status: "missing" });
    expect(await voice({ voice: false, speaker: 3, fetch: unreachable })).toMatchObject({ status: "ok", detail: expect.stringContaining("音声なし") });
  });

  it.skipIf(process.platform === "win32")("起動コマンドが設定されていれば、エンジンを起動してから確かめる", async () => {
    let calls = 0;
    const starting = (async (input: URL | RequestInfo, init?: RequestInit) =>
      ++calls <= 2 ? unreachable(input, init) : engine(input, init)) as typeof fetch;
    const started: string[] = [];
    const items = await checkEnvironment({
      ...base,
      voice: true,
      speaker: 3,
      fetch: starting,
      startCommand: "exit 0",
      onStart: (command) => started.push(command),
    });
    expect(items.find((item) => item.name === "読み上げ")).toMatchObject({ status: "ok" });
    expect(started).toEqual(["exit 0"]);

    // 起動しても応答しなければ、その内容を不足として示す
    const failed = await checkEnvironment({ ...base, voice: true, speaker: 3, fetch: unreachable, startCommand: "echo no-engine; exit 2" });
    expect(failed.find((item) => item.name === "読み上げ")).toMatchObject({
      status: "missing",
      detail: expect.stringMatching(/終了コード 2[\s\S]*no-engine/),
    });
  });

  it("指定した Chromium が無ければ不足として扱う", async () => {
    const items = await checkEnvironment({ ...base, voice: false, speaker: 3 });
    expect(items.find((item) => item.name === "Chromium")).toMatchObject({ status: "missing" });
    expect(items.map((item) => item.name)).toEqual(["読み上げ", "Chromium", "ffmpeg"]);
  });
});
