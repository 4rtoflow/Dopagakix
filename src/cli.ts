#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  createScriptFile,
  type DigestResult,
  digestSession,
  loadScriptFile,
  type RenderPipelineOptions,
  renderScriptFile,
} from "./pipeline.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS, type Effort } from "./script/generate.js";
import { STATUS_LABELS, type ScriptFile } from "./script/schema.js";
import { DEFAULT_MAX_DIGEST_CHARS } from "./transcript/digest.js";
import { listTranscripts } from "./transcript/locate.js";
import { readTranscript } from "./transcript/parse.js";
import { DEFAULT_SPEAKER, DEFAULT_VOICEVOX_URL, VoicevoxClient } from "./tts/voicevox.js";
import { log, progress } from "./util/log.js";
import { formatDateTime, formatStamp } from "./util/time.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** 長さがこの倍率を超えたら話速を上げる */
const LENGTH_TOLERANCE = 1.25;
const MAX_SPEED = 1.35;

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("正の数を指定してください。");
  return n;
}

function positiveInteger(value: string): number {
  const n = positiveNumber(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError("正の整数を指定してください。");
  return n;
}

function nonNegativeInteger(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("0 以上の整数を指定してください。");
  return n;
}

interface SessionFlags {
  project: string;
  session?: string;
  maxDigestChars: number;
  timezone?: string;
}

interface ScriptFlags {
  model: string;
  effort: Effort;
  seconds: number;
  fallback: boolean;
}

interface RenderFlags {
  voice: boolean;
  speaker: number;
  voicevoxUrl: string;
  speed: number;
  fps: number;
  chromium?: string;
}

function withSessionOptions(command: Command): Command {
  return command
    .argument("[transcript]", "セッションログ(.jsonl)のパス。省略するとプロジェクトの最新のログ")
    .option("-p, --project <dir>", "最新のログを探すプロジェクトのディレクトリ", process.cwd())
    .option("-s, --session <id>", "セッション ID(前方一致)")
    .option("--max-digest-chars <n>", "Claude に渡すダイジェストの最大文字数", positiveInteger, DEFAULT_MAX_DIGEST_CHARS)
    .option("--timezone <tz>", "時刻表示のタイムゾーン(例: Asia/Tokyo)。省略時は実行環境の設定");
}

function withScriptOptions(command: Command): Command {
  return command
    .option("--model <id>", "台本を作る Claude のモデル", DEFAULT_MODEL)
    .addOption(new Option("--effort <level>", "Claude の推論の深さ").choices(EFFORT_LEVELS).default(DEFAULT_EFFORT))
    .option("--seconds <n>", "動画の長さの目安(秒)", positiveNumber, 60)
    .option("--no-fallback", "安全分類器による拒否時に、別モデルへ切り替えて再実行する機能を使わない");
}

function withRenderOptions(command: Command): Command {
  return command
    .option("--no-voice", "読み上げなし(字幕のみ)で作る。VOICEVOX は不要")
    .option("--speaker <id>", "VOICEVOX の話者(スタイル)ID。`dopagakix speakers` で一覧", nonNegativeInteger, DEFAULT_SPEAKER)
    .option("--voicevox-url <url>", "VOICEVOX エンジンの URL", process.env.VOICEVOX_URL ?? DEFAULT_VOICEVOX_URL)
    .option("--speed <x>", "話速(1 が標準)", positiveNumber, 1.15)
    .option("--fps <n>", "フレームレート", positiveInteger, 30)
    .option("--chromium <path>", "描画に使う Chromium の実行ファイル(環境変数 DOPAGAKIX_CHROMIUM でも可)");
}

async function runDigest(transcript: string | undefined, flags: SessionFlags): Promise<DigestResult> {
  const result = await digestSession({
    transcript,
    session: flags.session,
    projectDir: flags.project,
    maxDigestChars: flags.maxDigestChars,
    timeZone: flags.timezone,
  });
  const notes = [
    `${result.digest.length.toLocaleString()} 文字`,
    result.level > 0 ? `予算に合わせて要約度 ${result.level}` : undefined,
    result.omittedLines > 0 ? `${result.omittedLines} 行を省略` : undefined,
    result.redactions > 0 ? `秘匿情報らしき文字列 ${result.redactions} 件をマスク` : undefined,
  ].filter(Boolean);
  log(`  ログ: ${result.file}`);
  log(`  ダイジェスト: ${notes.join("、")}`);
  return result;
}

async function runScript(digest: DigestResult, flags: ScriptFlags): Promise<ScriptFile> {
  log(`  ダイジェスト(${digest.digest.length.toLocaleString()} 文字)を Claude API(${flags.model})に送信します`);
  const file = await createScriptFile(digest, flags);
  log(
    `  台本: 「${file.script.title}」(${STATUS_LABELS[file.script.status]})` +
      ` / 入力 ${file.generator?.inputTokens?.toLocaleString()}・出力 ${file.generator?.outputTokens?.toLocaleString()} トークン` +
      (file.generator?.model !== flags.model ? ` / 応答モデル ${file.generator?.model}` : ""),
  );
  return file;
}

function renderOptions(
  flags: RenderFlags,
  extra: Pick<RenderPipelineOptions, "outFile" | "workDir" | "maxSeconds" | "timeZone">,
): RenderPipelineOptions {
  return {
    ...extra,
    voice: flags.voice,
    speaker: flags.speaker,
    voicevoxUrl: flags.voicevoxUrl,
    speed: flags.speed,
    maxSpeed: MAX_SPEED,
    fps: flags.fps,
    chromiumPath: flags.chromium,
    onSpeechProgress: progress(flags.voice ? "  音声合成" : "  字幕の時間割り当て"),
    onFrameProgress: progress("  描画"),
  };
}

async function runRender(file: ScriptFile, options: RenderPipelineOptions): Promise<void> {
  const result = await renderScriptFile(file, options);
  log(
    `完了: ${result.outFile}(${result.duration.toFixed(1)} 秒、話速 ${result.speed}` +
      `、撮影 ${result.stats.captured}/${result.stats.frames} フレーム)`,
  );
  if (result.credit) log(`  クレジット表記: ${result.credit}(VOICEVOX の利用規約により必要です)`);
  process.stdout.write(`${result.outFile}\n`);
}

const program = new Command()
  .name("dopagakix")
  .description("Agentic Coding のセッションログから、指示者向けの縦型サマリ動画を作る")
  .version(version);

withRenderOptions(
  withScriptOptions(
    withSessionOptions(
      program
        .command("generate")
        .description("セッションログから動画までを一度に作る(Claude API と VOICEVOX を使用)"),
    ),
  ),
)
  .option("--out-dir <dir>", "作業ファイルと動画を置くディレクトリ", "dopagakix-out")
  .option("-o, --out <file>", "動画の出力先(既定: <out-dir>/<日時>-<セッション>/summary.mp4)")
  .action(async (transcript: string | undefined, flags: SessionFlags & ScriptFlags & RenderFlags & { outDir: string; out?: string }) => {
    log("[1/3] セッションログを解析しています");
    const digest = await runDigest(transcript, flags);
    const runDir = path.resolve(
      flags.outDir,
      `${formatStamp(new Date(), flags.timezone)}-${(digest.facts.sessionId ?? "session").slice(0, 8)}`,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "digest.md"), digest.digest);

    log("[2/3] 台本を作成しています");
    const file = await runScript(digest, flags);
    await writeFile(path.join(runDir, "script.json"), `${JSON.stringify(file, null, 2)}\n`);

    log("[3/3] 音声と映像を作成しています");
    const outFile = flags.out ? path.resolve(flags.out) : path.join(runDir, "summary.mp4");
    await mkdir(path.dirname(outFile), { recursive: true });
    await runRender(
      file,
      renderOptions(flags, { outFile, workDir: runDir, maxSeconds: flags.seconds * LENGTH_TOLERANCE, timeZone: flags.timezone }),
    );
  });

withSessionOptions(program.command("digest").description("Claude に渡すダイジェストだけを作る(API は呼ばない)"))
  .option("-o, --out <file>", "書き出し先(省略時は標準出力)")
  .action(async (transcript: string | undefined, flags: SessionFlags & { out?: string }) => {
    const digest = await runDigest(transcript, flags);
    if (flags.out) {
      await writeFile(flags.out, digest.digest);
      log(`書き出しました: ${path.resolve(flags.out)}`);
    } else {
      process.stdout.write(digest.digest);
    }
  });

withScriptOptions(withSessionOptions(program.command("script").description("台本(script.json)までを作る")))
  .option("-o, --out <file>", "script.json の書き出し先", "script.json")
  .action(async (transcript: string | undefined, flags: SessionFlags & ScriptFlags & { out: string }) => {
    const digest = await runDigest(transcript, flags);
    const file = await runScript(digest, flags);
    await mkdir(path.dirname(path.resolve(flags.out)), { recursive: true });
    await writeFile(flags.out, `${JSON.stringify(file, null, 2)}\n`);
    log(`書き出しました: ${path.resolve(flags.out)}(編集してから render できます)`);
  });

withRenderOptions(
  program
    .command("render")
    .description("script.json から動画を作る(Claude API は呼ばない)")
    .argument("<script>", "script.json のパス"),
)
  .option("-o, --out <file>", "動画の出力先(既定: script.json と同じ場所の summary.mp4)")
  .option("--seconds <n>", "この長さの 1.25 倍を超えたら話速を上げて収める(秒)", positiveNumber, 60)
  .option("--timezone <tz>", "時刻表示のタイムゾーン(例: Asia/Tokyo)")
  .action(async (scriptPath: string, flags: RenderFlags & { out?: string; seconds: number; timezone?: string }) => {
    const file = await loadScriptFile(scriptPath);
    const outFile = path.resolve(flags.out ?? path.join(path.dirname(scriptPath), "summary.mp4"));
    // narration.wav と timeline.json は動画と同じ場所に置く
    const workDir = path.dirname(outFile);
    await mkdir(workDir, { recursive: true });
    await runRender(
      file,
      renderOptions(flags, { outFile, workDir, maxSeconds: flags.seconds * LENGTH_TOLERANCE, timeZone: flags.timezone }),
    );
  });

program
  .command("sessions")
  .description("プロジェクトのセッションログを新しい順に表示する")
  .option("-p, --project <dir>", "プロジェクトのディレクトリ", process.cwd())
  .option("-n, --limit <n>", "表示件数", positiveInteger, 10)
  .option("--timezone <tz>", "時刻表示のタイムゾーン")
  .action(async (flags: { project: string; limit: number; timezone?: string }) => {
    const transcripts = (await listTranscripts(flags.project)).slice(0, flags.limit);
    if (transcripts.length === 0) {
      log(`${path.resolve(flags.project)} のセッションログはありません。`);
      return;
    }
    for (const info of transcripts) {
      const session = await readTranscript(info.file);
      const size = `${Math.max(1, Math.round(info.size / 1024)).toLocaleString()} KB`;
      process.stdout.write(
        `${info.sessionId}  ${formatDateTime(info.modified.toISOString(), flags.timezone)}  ${size.padStart(9)}  ${session.title ?? "(無題)"}\n`,
      );
    }
  });

program
  .command("speakers")
  .description("VOICEVOX エンジンの話者とスタイル ID を表示する")
  .option("--voicevox-url <url>", "VOICEVOX エンジンの URL", process.env.VOICEVOX_URL ?? DEFAULT_VOICEVOX_URL)
  .action(async (flags: { voicevoxUrl: string }) => {
    const speakers = await new VoicevoxClient(flags.voicevoxUrl).speakers();
    for (const speaker of speakers) {
      for (const style of speaker.styles) {
        if (style.type && style.type !== "talk") continue;
        process.stdout.write(`${String(style.id).padStart(4)}  ${speaker.name}(${style.name})\n`);
      }
    }
    log("各キャラクターの利用規約を確認のうえで選んでください。動画には「VOICEVOX:キャラクター名」が表示されます。");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  log(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.DEBUG && error instanceof Error && error.stack) log(error.stack);
  process.exitCode = 1;
});
