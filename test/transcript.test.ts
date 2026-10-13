import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";
import { buildDigest, clip, collectFacts } from "../src/transcript/digest.js";
import { cleanUserText, readTranscript } from "../src/transcript/parse.js";
import type { ParsedSession } from "../src/transcript/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "session.jsonl");

describe("parseTranscript", () => {
  it("人間の発言だけを指示として取り出す", async () => {
    const session = await readTranscript(fixture);
    const prompts = session.events.filter((e) => e.kind === "user_prompt").map((e) => e.text);
    expect(prompts).toEqual([
      "ログイン画面のバリデーションを修正して、テストも追加してください。",
      "テストが通ったらコミットしてください。",
      "PRはまだ作らないでください。",
      "/review src/login.ts",
    ]);
  });

  it("セッションの属性と時刻範囲を読む", async () => {
    const session = await readTranscript(fixture);
    expect(session.title).toBe("ログイン画面のバリデーション修正");
    expect(session.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(session.cwd).toBe("/repo");
    expect(session.gitBranch).toBe("fix/login-validation");
    expect(session.models).toEqual(["claude-opus-5-5"]);
    expect(session.startTime).toBe("2026-10-01T01:00:01.000Z");
    expect(session.endTime).toBe("2026-10-01T01:10:00.000Z");
    expect(session.skippedLines).toBe(1);
  });

  it("サブエージェント内部・代筆メッセージ・空の思考ブロックを除外する", async () => {
    const session = await readTranscript(fixture);
    const texts = session.events.filter((e) => e.kind === "assistant_text").map((e) => e.text);
    expect(texts).toEqual([
      "まず現状を確認します。",
      "バリデーションを修正し、テストを2件追加しました。テストは全て成功しています。PRはご指示どおり作成していません。",
    ]);
  });

  it("AskUserQuestion の回答と中断を記録する", async () => {
    const session = await readTranscript(fixture);
    const answer = session.events.find((e) => e.kind === "user_answer");
    expect(answer).toEqual({
      kind: "user_answer",
      time: "2026-10-01T01:02:00.000Z",
      answers: [{ question: "メールアドレスの検証はどこまで厳密にしますか?", answer: "簡易チェック" }],
    });
    expect(session.events.some((e) => e.kind === "interrupt")).toBe(true);
  });
});

describe("cleanUserText", () => {
  it("system-reminder を除き、コマンド表記を整える", () => {
    expect(cleanUserText("<system-reminder>x</system-reminder> 本文 ")).toBe("本文");
    expect(cleanUserText("<command-name>/clear</command-name><command-args></command-args>")).toBe("/clear");
    expect(cleanUserText("<bash-input>ls -la</bash-input>")).toBe("! ls -la");
    expect(cleanUserText("<local-command-stdout>ok</local-command-stdout>")).toBe("");
  });
});

describe("collectFacts", () => {
  it("変更ファイルとコマンドの成否を数える", async () => {
    const facts = collectFacts(await readTranscript(fixture));
    expect(facts.files).toEqual([
      { path: "test/login.test.ts", added: 3, removed: 0, edits: 1, created: true },
      { path: "src/login.ts", added: 1, removed: 0, edits: 1, created: false },
    ]);
    expect(facts.commandsRun).toBe(3);
    expect(facts.commandsFailed).toBe(1);
    expect(facts.userPrompts).toBe(4);
    expect(facts.elapsedMinutes).toBe(10);
    expect(facts.activeMinutes).toBe(10);
    expect(facts.project).toBe("repo");
    expect(facts.toolCounts).toMatchObject({ Bash: 3, Edit: 1, Write: 1, Read: 1, AskUserQuestion: 1 });
  });
});

describe("activeMinutes", () => {
  it("15 分を超える間隔(放置)は作業時間に含めない", () => {
    const session: ParsedSession = {
      file: "x",
      models: [],
      skippedLines: 0,
      startTime: "2026-10-06T08:00:00.000Z",
      endTime: "2026-10-13T08:10:00.000Z",
      events: [
        { kind: "user_prompt", time: "2026-10-06T08:00:00.000Z", text: "a" },
        { kind: "assistant_text", time: "2026-10-06T08:05:00.000Z", text: "b" },
        { kind: "user_prompt", time: "2026-10-13T08:00:00.000Z", text: "c" },
        { kind: "assistant_text", time: "2026-10-13T08:10:00.000Z", text: "d" },
      ],
    };
    const facts = collectFacts(session);
    expect(facts.elapsedMinutes).toBe(7 * 24 * 60 + 10);
    expect(facts.activeMinutes).toBe(15);
  });
});

describe("buildDigest", () => {
  it("時系列ログに指示・回答・エラー・最終発言を含める", async () => {
    const session = await readTranscript(fixture);
    const digest = buildDigest(session, collectFacts(session), { timeZone: "UTC" });
    expect(digest.level).toBe(0);
    expect(digest.text).toContain("01:00 [USER] ログイン画面のバリデーションを修正して");
    expect(digest.text).toContain("[ANSWER] Q「メールアドレスの検証はどこまで厳密にしますか?」→ A「簡易チェック」");
    expect(digest.text).toMatch(/\[TOOL#(\d+)\] Bash: npm test\(Run tests\)[\s\S]*\[RESULT#\1・エラー\]/);
    expect(digest.text).toContain("[AI・最終発言] バリデーションを修正し");
    expect(digest.text).toContain("test/login.test.ts (+3 -0, 新規)");
    // Read の本文は載せない
    expect(digest.text).not.toContain("export function validate");
  });

  it("予算を超えると簡潔な表記に切り替え、指示者の発言は残す", async () => {
    const session = await readTranscript(fixture);
    const facts = collectFacts(session);
    const full = buildDigest(session, facts, { timeZone: "UTC" });
    const small = buildDigest(session, facts, { timeZone: "UTC", maxChars: full.text.length - 200 });
    expect(small.level).toBeGreaterThan(0);
    expect(small.text.length).toBeLessThanOrEqual(full.text.length - 200);
    expect(small.text).toContain("PRはまだ作らないでください。");

    const tiny = buildDigest(session, facts, { timeZone: "UTC", maxChars: 1500 });
    expect(tiny.text.length).toBeLessThanOrEqual(1500);
    expect(tiny.text).toContain("# セッション概要");
  });
});

describe("redactSecrets", () => {
  it("代表的な秘密情報を伏せ字にする", () => {
    const input = [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      "aws AKIAIOSFODNN7EXAMPLE",
      "url https://user:hunter22@example.com/repo.git",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "password = 'correct-horse-battery'",
    ].join("\n");
    const { text, count } = redactSecrets(input);
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("ghp_0123456789");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("hunter22");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(text).not.toContain("correct-horse-battery");
    expect(text).toContain("https://user:[REDACTED]@example.com");
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it("通常の文章やコードは変えない", () => {
    const input = "max_tokens: 16000 で呼び出す。const tokens = count(text);";
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });
});

describe("clip", () => {
  it("長い文字列の中間を省略する", () => {
    const clipped = clip("a".repeat(50) + "b".repeat(50), 20);
    expect(clipped.startsWith("aaaaaaaa")).toBe(true);
    expect(clipped.endsWith("bbbbbbbbbbbb")).toBe(true);
    expect(clipped).toContain("80 文字省略");
  });
});
