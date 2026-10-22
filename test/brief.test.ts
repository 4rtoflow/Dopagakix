import { describe, expect, it } from "vitest";
import { buildBrief } from "../src/brief.js";
import type { CheckResult } from "../src/doctor.js";
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

const ok: CheckResult[] = [
  { id: "voicevox", group: "読み上げ", name: "VOICEVOX ENGINE", status: "ok", detail: "0.25.2(http://127.0.0.1:50021)" },
  { id: "chromium", group: "描画", name: "Chromium", status: "ok", detail: "/usr/bin/chromium(起動できます)" },
];

const input = {
  facts,
  reportFile: "dopagakix-out/x/report.json",
  checkCommand: "dopagakix check dopagakix-out/x/report.json --session 4e4e81c0",
  renderCommand: "dopagakix render dopagakix-out/x/report.json --session 4e4e81c0",
  digestCommand: "dopagakix digest --session 4e4e81c0 -o dopagakix-out/x/digest.md",
  seconds: 60,
  voice: true,
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

  it("口調がなければ丁寧語、足りないものがあれば冒頭で知らせ、doctor へ案内する", () => {
    const text = buildBrief({
      ...input,
      environment: [
        ...ok,
        { id: "ffmpeg", group: "描画", name: "ffmpeg", status: "error", detail: "ffmpeg を実行できません", fix: "ffmpeg を入れる" },
        { id: "skill", group: "Claude Code", name: "スキル", status: "warn", detail: "1 行目\n2 行目" },
      ],
    });
    expect(text).toContain("## 読み上げ文の口調: 丁寧語");
    expect(text).toMatch(/^# 動画レポートの準備\n\n\*\*描画に必要なものが不足しています\(ffmpeg\)。`dopagakix doctor` を実行し/);
    expect(text).toContain("- ffmpeg: [不足] ffmpeg を実行できません");
    // 注意は不足とは分けて示し、複数行は 1 行にまとめる
    expect(text).toContain("- スキル: [注意] 1 行目 / 2 行目");
  });

  it("字幕のみなら、読み上げなしであることを環境に示す", () => {
    const text = buildBrief({ ...input, voice: false, environment: [ok[1]!] });
    expect(text).toContain("- 読み上げ: なし(字幕のみで作成。動画の柱に「音声なし」と表示)");
    expect(text).not.toContain("VOICEVOX ENGINE");
  });
});
