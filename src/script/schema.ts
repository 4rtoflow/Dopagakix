import { z } from "zod";
import { SessionFactsSchema } from "../facts.js";

export const STATUS_VALUES = ["completed", "partial", "blocked", "failed"] as const;
export const STATUS_LABELS = { completed: "完了", partial: "一部完了", blocked: "判断待ち", failed: "未達成" } as const;
export const CHECK_RESULTS = ["pass", "fail", "not_run"] as const;

const Narration = z
  .array(z.string())
  .describe("このシーンの読み上げ文。字幕にもそのまま表示する。1要素=1文、1〜3文。");

/**
 * 動画の台本。作業をしたエージェント自身が書く(report.json)。画面に出す数値
 * (変更ファイル数など)はここに含めず、ログから機械的に集計した SessionFacts を使う。
 */
export const VideoScriptSchema = z.object({
  title: z.string().describe("動画タイトル。作業内容を表す名詞句(全角20文字以内)"),
  status: z
    .enum(STATUS_VALUES)
    .describe(
      "completed=指示どおり完了 / partial=一部完了・残作業あり / blocked=指示者の判断や情報待ちで停止 / failed=目的を達成できなかった",
    ),
  headline: z.string().describe("結論を一文で(全角40文字以内)"),
  opening: z.object({ narration: Narration }),
  request: z.object({
    summary: z.string().describe("指示者が依頼した内容の要約(全角60文字以内)"),
    narration: Narration,
  }),
  work: z.object({
    items: z.array(z.string()).describe("実施した主な作業。成果ベースで最大5件、各全角28文字以内"),
    narration: Narration,
  }),
  verification: z.object({
    items: z
      .array(
        z.object({
          label: z.string().describe("テスト・ビルド・動作確認などの内容(全角24文字以内)"),
          result: z.enum(CHECK_RESULTS).describe("pass=成功 / fail=失敗 / not_run=未実施"),
        }),
      )
      .describe("検証の結果。最大4件。ログに実行記録がないものは not_run"),
    narration: Narration,
  }),
  decisions: z.object({
    items: z
      .array(
        z.object({
          title: z.string().describe("判断・対応してほしいこと(全角24文字以内)"),
          detail: z.string().describe("背景や選択肢(全角50文字以内)"),
        }),
      )
      .describe("指示者に判断・承認・手作業をお願いしたいこと。最大3件。なければ空配列"),
    narration: Narration,
  }),
  next_steps: z.object({
    items: z.array(z.string()).describe("次にやるべきこと。最大3件、各全角28文字以内"),
    narration: Narration,
  }),
});

export type VideoScript = z.infer<typeof VideoScriptSchema>;
export type ScriptStatus = (typeof STATUS_VALUES)[number];
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const AUTHORS = ["agent", "manual"] as const;
export type Author = (typeof AUTHORS)[number];

/**
 * script.json の形式。描画に使った台本と事実情報をまとめて残し、同じ内容で描画し直せるようにする。
 * render は、エージェントが書いた台本(VideoScript)とこの形式のどちらも受け付ける。
 */
export const ScriptFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  /** 台本の書き手。agent=作業をした AI エージェント自身、manual=人が手で書いたもの */
  author: z.enum(AUTHORS).default("agent"),
  /** 読み上げ文の口調(確認に使ったもの。記録用) */
  persona: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 読み上げの有無と話者(記録用。描画し直すときは、その時の指定で読み上げる) */
  voice: z
    .object({ enabled: z.boolean(), speaker: z.number().int().optional(), name: z.string().optional(), style: z.string().optional() })
    .optional(),
  facts: SessionFactsSchema,
  script: VideoScriptSchema,
});

export type ScriptFile = z.infer<typeof ScriptFileSchema>;
