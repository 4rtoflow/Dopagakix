import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZUNDAMON } from "../src/persona.js";
import { generateScript, type ScriptClient, ScriptGenerationError } from "../src/script/generate.js";
import { narrationBudget } from "../src/script/prompt.js";
import { scriptJsonSchema } from "../src/script/schema.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

interface FakeMessage {
  stop_reason: string;
  stop_details?: { category: string | null } | null;
  content: Array<{ type: string; text?: string }>;
  model?: string;
}

function fakeClient(message: FakeMessage): { client: ScriptClient; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const stream = (params: Record<string, unknown>) => {
    requests.push(params);
    return {
      finalMessage: async () => ({
        model: "claude-opus-5-5",
        stop_details: null,
        usage: { input_tokens: 1200, output_tokens: 300 },
        ...message,
      }),
    };
  };
  return { client: { beta: { messages: { stream } } } as unknown as ScriptClient, requests };
}

async function sampleScriptText(): Promise<string> {
  return readFile(path.join(fixtures, "script.json"), "utf8");
}

describe("generateScript", () => {
  it("構造化出力・effort・フォールバックを指定して呼び出す", async () => {
    const { client, requests } = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: await sampleScriptText() }],
    });
    const result = await generateScript("ダイジェスト本文", { targetSeconds: 60, client });

    expect(result.script.title).toBe("ログイン画面のバリデーション修正");
    expect(result.inputTokens).toBe(1200);
    const request = requests[0]!;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
    expect(request.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect(JSON.stringify(request.messages)).toContain("<digest>\\nダイジェスト本文\\n</digest>");
    expect(String(request.system)).toContain(`全角 ${narrationBudget(60)} 文字程度`);
  });

  it("フォールバック非対応モデルや Haiku では該当パラメータを送らない", async () => {
    const { client, requests } = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: await sampleScriptText() }],
    });
    await generateScript("x", { targetSeconds: 45, client, model: "claude-haiku-4-5" });
    expect(requests[0]!.fallbacks).toBeUndefined();
    expect(requests[0]!.betas).toBeUndefined();
    expect(requests[0]!.output_config).not.toHaveProperty("effort");
  });

  it("拒否・出力切れ・スキーマ違反をエラーにする", async () => {
    const refusal = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] });
    await expect(generateScript("x", { targetSeconds: 60, client: refusal.client })).rejects.toThrow(/分類: cyber/);

    const truncated = fakeClient({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] });
    await expect(generateScript("x", { targetSeconds: 60, client: truncated.client })).rejects.toThrow(
      ScriptGenerationError,
    );

    const invalid = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"title":"x"}' }] });
    await expect(generateScript("x", { targetSeconds: 60, client: invalid.client })).rejects.toThrow(/スキーマ/);
  });

  it("口調を指定すると読み上げ文だけをその口調で書かせ、外れた文を報告する", async () => {
    const { client, requests } = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: await sampleScriptText() }],
    });
    const result = await generateScript("x", { targetSeconds: 60, client, persona: ZUNDAMON });
    const system = String(requests[0]!.system);
    expect(system).toContain("narration は「ずんだもん」が読み上げます");
    expect(system).toContain("「ログイン画面の修正が終わったのだ。」");
    expect(system).toContain("口調を変えるのは narration だけです");
    expect(system).not.toContain("丁寧語(です・ます)");
    // フィクスチャはです・ます調なので、全文が口調から外れていると報告される
    expect(result.offStyleLines).toContain("ログイン画面のバリデーション修正が完了しました。");

    const plain = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: await sampleScriptText() }] });
    const neutral = await generateScript("x", { targetSeconds: 60, client: plain.client });
    expect(String(plain.requests[0]!.system)).toContain("丁寧語(です・ます)");
    expect(neutral.offStyleLines).toEqual([]);
  });

  it("台本中の秘匿情報を伏せ字にし、件数上限で切り詰める", async () => {
    const script = JSON.parse(await sampleScriptText());
    script.work.items = ["a", "b", "c", "d", "e", "f", "token=abcdef123456"];
    script.headline = "鍵 sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa を設定";
    const { client } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(script) }] });
    const result = await generateScript("x", { targetSeconds: 60, client });
    expect(result.script.work.items).toHaveLength(5);
    expect(result.script.headline).not.toContain("sk-ant");
  });
});

describe("scriptJsonSchema", () => {
  it("enum と additionalProperties: false を保持する", () => {
    const schema = scriptJsonSchema() as {
      properties: Record<string, Record<string, unknown>>;
      additionalProperties: boolean;
      $schema?: string;
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.status!.enum).toEqual(["completed", "partial", "blocked", "failed"]);
  });
});
