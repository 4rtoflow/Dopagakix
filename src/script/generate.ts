import Anthropic from "@anthropic-ai/sdk";
import { normalizeScript } from "./normalize.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { scriptJsonSchema, type VideoScript, VideoScriptSchema } from "./schema.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
/** 要約は高い推論量を必要としないため、Opus 5.5 の既定値と同じ medium を明示する。 */
export const DEFAULT_EFFORT: Effort = "medium";

/** server-side fallback の "default" モードを受け付けるモデル */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** テストで差し替えられるよう、使う API だけに絞ったクライアントの型 */
export interface ScriptClient {
  beta: { messages: Pick<Anthropic["beta"]["messages"], "stream"> };
}

export interface GenerateOptions {
  model?: string;
  effort?: Effort;
  targetSeconds: number;
  /** 安全分類器による拒否時に、API 側で別モデルへ切り替えて再実行させる */
  fallback?: boolean;
  client?: ScriptClient;
}

export interface GenerateResult {
  script: VideoScript;
  /** 実際に応答したモデル(フォールバックが働いた場合は元の指定と異なる) */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class ScriptGenerationError extends Error {
  override name = "ScriptGenerationError";
}

function explainApiError(error: unknown, model: string): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ScriptGenerationError("Claude API の認証に失敗しました。ANTHROPIC_API_KEY を確認してください。");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ScriptGenerationError(`このキーでは ${model} を利用できません: ${error.message}`);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ScriptGenerationError(`モデル ${model} が見つかりません。--model を確認してください。`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ScriptGenerationError("Claude API のレート制限に達しました。時間をおいて再実行してください。");
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ScriptGenerationError(`Claude API がリクエストを受け付けませんでした: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ScriptGenerationError("Claude API に接続できませんでした。ネットワーク設定を確認してください。");
  }
  if (error instanceof Anthropic.APIError) {
    return new ScriptGenerationError(`Claude API エラー(${error.status ?? "不明"}): ${error.message}`);
  }
  if (error instanceof Anthropic.AnthropicError) {
    // 認証情報が見つからない場合など、リクエスト前にクライアント側で失敗したもの
    return new ScriptGenerationError(
      `Claude API クライアントの設定エラー: ${error.message}(ANTHROPIC_API_KEY が設定されているか確認してください)`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** ダイジェストから動画台本を生成する。 */
export async function generateScript(digest: string, options: GenerateOptions): Promise<GenerateResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const client: ScriptClient = options.client ?? new Anthropic();
  const useFallback = (options.fallback ?? true) && FALLBACK_MODELS.has(model);
  // Haiku 4.5 は effort を受け付けない
  const supportsEffort = !model.startsWith("claude-haiku");

  let message;
  try {
    // 入力が長くなりうるので、タイムアウトを避けるためストリーミングで受け取る
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32_000,
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: {
        ...(supportsEffort ? { effort: options.effort ?? DEFAULT_EFFORT } : {}),
        format: { type: "json_schema", schema: scriptJsonSchema() },
      },
      system: buildSystemPrompt(options.targetSeconds),
      messages: [{ role: "user", content: buildUserMessage(digest) }],
    });
    message = await stream.finalMessage();
  } catch (error) {
    throw explainApiError(error, model);
  }

  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "不明";
    throw new ScriptGenerationError(`Claude が台本の生成を断りました(分類: ${category})。`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new ScriptGenerationError("出力が上限に達し、台本が途中で切れました。");
  }

  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ScriptGenerationError("台本の JSON を解釈できませんでした。");
  }
  const parsed = VideoScriptSchema.safeParse(json);
  if (!parsed.success) {
    throw new ScriptGenerationError(`台本がスキーマに合いません: ${parsed.error.message}`);
  }

  return {
    script: normalizeScript(parsed.data),
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
