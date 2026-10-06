/** セッションログ(JSONL)から取り出した、要約に必要な出来事。 */
export type SessionEvent =
  | { kind: "user_prompt"; time?: string; text: string }
  | { kind: "user_answer"; time?: string; answers: QuestionAnswer[] }
  | { kind: "assistant_text"; time?: string; text: string }
  | {
      kind: "tool_call";
      time?: string;
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      time?: string;
      toolUseId: string;
      name?: string;
      isError: boolean;
      text: string;
      /** ログに記録された構造化結果(toolUseResult)。形式はツールごとに異なる。 */
      detail?: unknown;
    }
  | { kind: "compact_summary"; time?: string; text: string }
  | { kind: "interrupt"; time?: string };

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface ParsedSession {
  file: string;
  sessionId?: string;
  /** Claude Code が自動生成したセッション題名(ai-title) */
  title?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  models: string[];
  startTime?: string;
  endTime?: string;
  events: SessionEvent[];
  /** JSON として読めなかった行の数 */
  skippedLines: number;
}
