import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionFacts } from "../src/facts.js";
import { ZUNDAMON } from "../src/persona.js";
import { checkScript, narrationBudget } from "../src/script/check.js";
import { type VideoScript, VideoScriptSchema } from "../src/script/schema.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const loadScript = async (): Promise<VideoScript> =>
  VideoScriptSchema.parse(JSON.parse(await readFile(path.join(fixtures, "script.json"), "utf8")));

const facts: SessionFacts = {
  userPrompts: 2,
  toolCalls: 10,
  toolCounts: { Edit: 4 },
  commandsRun: 3,
  commandsFailed: 0,
  files: [],
  models: [],
};

const at = (result: ReturnType<typeof checkScript>) => result.issues.map((issue) => issue.at);

describe("checkScript", () => {
  it("問題のない台本では警告を出さず、文字数を数える", async () => {
    const script = await loadScript();
    const result = checkScript(script, { seconds: 60, facts });
    expect(result.issues).toEqual([]);
    expect(result.sentences).toBe(8);
    expect(result.narrationChars).toBeGreaterThan(200);
    expect(result.budget).toBe(narrationBudget(60));
  });

  it("口調の文末になっていない読み上げ文と、口調の付いた画面の文字を挙げる", async () => {
    const script = await loadScript();
    script.opening.narration = ["ログイン画面の修正が終わったのだ。"];
    script.headline = "テストも通ったのだ";
    const result = checkScript(script, { seconds: 60, persona: ZUNDAMON });
    const endings = result.issues.filter((issue) => issue.message.includes("ずんだもんの口調の文末"));
    // opening 以外の 7 文は丁寧語のまま
    expect(endings).toHaveLength(7);
    expect(at(result)).not.toContain("opening.narration[0]");
    expect(result.issues).toContainEqual(expect.objectContaining({ at: "headline", message: expect.stringContaining("中立") }));
  });

  it("長すぎる文と読み上げにくい表記を挙げ、製品名は許す", async () => {
    const script = await loadScript();
    script.work.narration = [
      "src/login.ts の validate() を直しました。",
      "詳しくは https://example.com を見てください。",
      "Node.js と Next.js の設定を確認しました。",
      "完了しました🎉",
    ];
    script.request.narration = ["あ".repeat(50)];
    const result = checkScript(script, { seconds: 60 });
    const messages = Object.fromEntries(result.issues.map((issue) => [issue.at, issue.message]));
    expect(messages["work.narration[0]"]).toMatch(/コード・記号・ファイル名・パス/);
    expect(messages["work.narration[1]"]).toMatch(/URL/);
    expect(messages["work.narration[2]"]).toBeUndefined();
    expect(messages["work.narration[3]"]).toMatch(/絵文字/);
    expect(messages["work.narration"]).toMatch(/4 文あります/);
    expect(messages["request.narration[0]"]).toMatch(/50 文字/);
  });

  it("空のシーン・表示しきれない件数・長すぎる画面の文字を挙げる", async () => {
    const script = await loadScript();
    script.decisions.narration = [];
    script.work.items = Array.from({ length: 7 }, (_, i) => `作業${i}`);
    script.title = "とても長いタイトル".repeat(4);
    const result = checkScript(script, { seconds: 60 });
    expect(at(result)).toEqual(expect.arrayContaining(["decisions.narration", "work.items", "title"]));
    expect(result.issues.find((issue) => issue.at === "work.items")?.message).toMatch(/先頭の 5 件/);
  });

  it("目安を大きく超える長さを警告する", async () => {
    const script = await loadScript();
    const long = "読み上げる文がとても長いのでこの文は三十文字ほどあります。";
    for (const scene of [script.opening, script.request, script.work, script.verification, script.decisions, script.next_steps]) {
      scene.narration = [long, long, long];
    }
    expect(at(checkScript(script, { seconds: 60 }))).toContain("narration");
    expect(at(checkScript(script, { seconds: 120 }))).not.toContain("narration");
  });

  it("状態と検証結果の食い違い、実行記録のない検証結果を挙げる", async () => {
    const script = await loadScript();
    script.verification.items = [{ label: "単体テスト", result: "fail" }];
    expect(at(checkScript(script, { seconds: 60 }))).toContain("status");

    script.status = "blocked";
    script.decisions.items = [];
    expect(at(checkScript(script, { seconds: 60 }))).toContain("decisions.items");

    const noCommands = { ...facts, commandsRun: 0 };
    expect(at(checkScript(script, { seconds: 60, facts: noCommands }))).toContain("verification.items");
    script.verification.items = [{ label: "単体テスト", result: "not_run" }];
    expect(at(checkScript(script, { seconds: 60, facts: noCommands }))).not.toContain("verification.items");
  });
});
