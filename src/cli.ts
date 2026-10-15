#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { buildBrief, checkEnvironment } from "./brief.js";
import { type Persona, personaMismatch, resolvePersona } from "./persona.js";
import {
  createSynthesizer,
  DEFAULT_OUT_DIR,
  digestSession,
  loadReport,
  loadSession,
  prepareOutputRoot,
  renderReport,
  resolveRenderPaths,
} from "./pipeline.js";
import { checkScript } from "./script/check.js";
import { STATUS_LABELS } from "./script/schema.js";
import { installSkill, SKILL_NAME, skillsDir } from "./skill.js";
import { DEFAULT_MAX_DIGEST_CHARS } from "./transcript/digest.js";
import { type LocatedTranscript, type LocateOptions, listTranscripts } from "./transcript/locate.js";
import { readTranscript } from "./transcript/parse.js";
import { DEFAULT_SPEAKER, DEFAULT_VOICEVOX_URL, VoicevoxClient } from "./tts/voicevox.js";
import { log, progress } from "./util/log.js";
import { formatDateTime, formatStamp } from "./util/time.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** 長さがこの倍率を超えたら話速を上げる */
const LENGTH_TOLERANCE = 1.25;
const DEFAULT_SPEED = 1.25;
const MAX_SPEED = 1.45;
const DEFAULT_SECONDS = 60;

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
  transcript?: string;
  session?: string;
  project: string;
}

interface VoiceFlags {
  voice: boolean;
  speaker: number;
  voicevoxUrl: string;
  persona: string;
}

interface RenderFlags {
  speed: number;
  fps: number;
  chromium?: string;
}

function withSessionOptions(command: Command): Command {
  return command
    .option("--transcript <file>", "セッションログ(.jsonl)のパス")
    .option("-s, --session <id>", "セッション ID(前方一致)。省略時は実行中の Claude Code のセッション、なければプロジェクトの最新のログ")
    .option("-p, --project <dir>", "ログを探すプロジェクトのディレクトリ", process.cwd());
}

function withVoiceOptions(command: Command): Command {
  return command
    .option("--no-voice", "読み上げなし(字幕のみ)で作る。VOICEVOX は不要")
    .addOption(
      new Option("--speaker <id>", "VOICEVOX の話者(スタイル)ID。`dopagakix speakers` で一覧")
        .argParser(nonNegativeInteger)
        .default(DEFAULT_SPEAKER)
        .env("DOPAGAKIX_SPEAKER"),
    )
    .addOption(new Option("--voicevox-url <url>", "VOICEVOX エンジンの URL").default(DEFAULT_VOICEVOX_URL).env("VOICEVOX_URL"))
    .addOption(
      new Option("--persona <name>", "読み上げ文の口調。auto=話者から判断 / none=丁寧語 / zundamon / 口調設定の JSON ファイル")
        .default("auto")
        .env("DOPAGAKIX_PERSONA"),
    );
}

function withCreditOption(command: Command): Command {
  return command.addOption(
    new Option(
      "--credit <text>",
      "動画に表示する音声のクレジット表記。省略時は話者から決める(音声ライブラリの規約で書式が決まっているものは規約どおり)",
    ).env("DOPAGAKIX_CREDIT"),
  );
}

function withVideoDirOption(command: Command): Command {
  return command.addOption(
    new Option(
      "--video-dir <dir>",
      "完成した動画だけを置くフォルダ。動画の名前は「台本のフォルダ名-タイトル.mp4」になり、作業ファイルは台本と同じ場所に残す",
    ).env("DOPAGAKIX_VIDEO_DIR"),
  );
}

function withSecondsOption(command: Command): Command {
  return command.option("--seconds <n>", "動画の長さの目安(秒)。読み上げ文の文字数の目安と、話速の調整に使う", positiveNumber, DEFAULT_SECONDS);
}

function withRenderOptions(command: Command): Command {
  return command
    .option("--speed <x>", "話速(1 が標準)", positiveNumber, DEFAULT_SPEED)
    .option("--fps <n>", "フレームレート", positiveInteger, 30)
    .option("--chromium <path>", "描画に使う Chromium の実行ファイル(環境変数 DOPAGAKIX_CHROMIUM でも可)");
}

function locateOptions(flags: SessionFlags): LocateOptions {
  return { transcript: flags.transcript, session: flags.session, projectDir: flags.project };
}

const FOUND_BY: Record<LocatedTranscript["how"], string> = {
  path: "指定したファイル",
  session: "指定したセッション",
  current: "実行中のセッション",
  latest: "プロジェクトの最新のログ",
};

async function choosePersona(flags: VoiceFlags): Promise<Persona | undefined> {
  return resolvePersona({ option: flags.persona, speaker: flags.speaker, voice: flags.voice, voicevoxUrl: flags.voicevoxUrl });
}

/** コマンドの表示用に、cwd の中なら相対パスにする */
function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

const commandLine = (args: string[]) => args.map(shellQuote).join(" ");

/** prepare に明示した設定を、案内する check / render / digest のコマンドに引き継ぐ */
function explicitArgs(command: Command, flags: object, keys: string[]): string[] {
  const values = flags as Record<string, unknown>;
  const args: string[] = [];
  for (const key of keys) {
    if (command.getOptionValueSource(key) !== "cli") continue;
    if (key === "voice") {
      if (values.voice === false) args.push("--no-voice");
      continue;
    }
    args.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(values[key]));
  }
  return args;
}

const program = new Command()
  .name("dopagakix")
  .description("AI エージェントが書いた作業報告の台本から、指示者向けの縦型動画を作る")
  .version(version);

type PrepareFlags = SessionFlags &
  VoiceFlags & { credit?: string; videoDir?: string; seconds: number; outDir: string; timezone?: string; chromium?: string };

withVideoDirOption(
  withCreditOption(
    withSecondsOption(
      withVoiceOptions(
        withSessionOptions(
          program
            .command("prepare")
            .description("動画レポートの準備。出力先を作り、台本を書くのに必要な情報(画面に出る数値・口調・長さ・環境)を表示する"),
        ),
      ),
    ),
  ),
)
  .option("--out-dir <dir>", "出力先の親ディレクトリ(中身は git の管理対象から外す)", DEFAULT_OUT_DIR)
  .option("--timezone <tz>", "時刻表示のタイムゾーン(例: Asia/Tokyo)。省略時は実行環境の設定")
  .option("--chromium <path>", "描画に使う Chromium の実行ファイル")
  .action(async (flags: PrepareFlags, command: Command) => {
    const outRoot = path.resolve(flags.outDir);
    const loaded = await loadSession(locateOptions(flags), [outRoot]);
    log(`ログ: ${loaded.file}(${FOUND_BY[loaded.how]})`);
    const persona = await choosePersona(flags);
    const environment = await checkEnvironment(flags);

    await prepareOutputRoot(outRoot);
    const runDir = path.join(outRoot, `${formatStamp(new Date(), flags.timezone)}-${loaded.sessionId.slice(0, 8)}`);
    await mkdir(runDir, { recursive: true });
    const report = displayPath(path.join(runDir, "report.json"));

    const session = flags.transcript ? ["--transcript", loaded.file] : ["--session", loaded.sessionId];
    const shared = [...session, ...explicitArgs(command, flags, ["voice", "speaker", "voicevoxUrl", "persona", "seconds"])];
    const timezone = explicitArgs(command, flags, ["timezone"]);
    process.stdout.write(
      buildBrief({
        facts: loaded.facts,
        reportFile: report,
        checkCommand: commandLine(["dopagakix", "check", report, ...shared]),
        renderCommand: commandLine([
          "dopagakix",
          "render",
          report,
          ...shared,
          ...timezone,
          ...explicitArgs(command, flags, ["credit", "chromium", "videoDir"]),
        ]),
        digestCommand: commandLine(["dopagakix", "digest", ...session, ...timezone, "-o", displayPath(path.join(runDir, "digest.md"))]),
        persona,
        seconds: flags.seconds,
        environment,
        timeZone: flags.timezone,
      }),
    );
    if (environment.some((item) => item.status === "missing")) process.exitCode = 1;
  });

type CheckFlags = SessionFlags & VoiceFlags & { seconds: number };

withSecondsOption(
  withVoiceOptions(
    withSessionOptions(
      program
        .command("check")
        .description("台本を確かめる(形式、口調、長さ、読み上げにくい表記、数値との食い違い)。描画はしない")
        .argument("<report>", "台本(report.json)または script.json のパス"),
    ),
  ),
).action(async (reportPath: string, flags: CheckFlags) => {
  const report = await loadReport(reportPath);
  let facts = report.facts;
  let compared = "script.json に記録された数値と照合";
  if (!facts) {
    try {
      const loaded = await loadSession(locateOptions(flags), [path.dirname(path.resolve(reportPath))]);
      facts = loaded.facts;
      compared = `セッション ${loaded.sessionId.slice(0, 8)} のログ(${FOUND_BY[loaded.how]})と照合`;
    } catch (error) {
      compared = `省略(${(error as Error).message})`;
    }
  }
  const persona = await choosePersona(flags);
  const result = checkScript(report.raw, { persona, facts, seconds: flags.seconds });
  const lines = [
    `形式: 正しい(「${report.script.title}」、${STATUS_LABELS[report.script.status]})`,
    `読み上げ文: ${result.sentences} 文、計 ${result.narrationChars} 文字(目安 ${result.budget} 文字、約 ${flags.seconds} 秒)`,
    `口調: ${persona ? `${persona.name}(文末を確認)` : "丁寧語"}`,
    `数値: ${compared}`,
    result.issues.length > 0 ? `警告 ${result.issues.length} 件:` : "警告: なし",
    ...result.issues.map((issue) => `- ${issue.at}: ${issue.message}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
});

type RenderCommandFlags = SessionFlags &
  VoiceFlags &
  RenderFlags & { credit?: string; out?: string; videoDir?: string; seconds: number; timezone?: string };

withVideoDirOption(
  withCreditOption(
    withRenderOptions(
      withSecondsOption(
        withVoiceOptions(
          withSessionOptions(
            program
              .command("render")
              .description("台本から動画を作る。画面の数値はセッションログから集計する")
              .argument("<report>", "台本(report.json)、または描画済みの script.json(記録された数値で描画し直す)"),
          ),
        ),
      ),
    ),
  ),
)
  .option("-o, --out <file>", "動画の出力先。作業ファイルも同じ場所に置き、--video-dir より優先する(既定: 台本と同じ場所の summary.mp4)")
  .option("--timezone <tz>", "時刻表示のタイムゾーン(例: Asia/Tokyo)。省略時は実行環境の設定")
  .action(async (reportPath: string, flags: RenderCommandFlags) => {
    const report = await loadReport(reportPath);
    let facts = report.facts;
    if (facts) {
      log("数値: script.json に記録されたものを使います");
    } else {
      const loaded = await loadSession(locateOptions(flags), [path.dirname(path.resolve(reportPath))]);
      facts = loaded.facts;
      log(`ログ: ${loaded.file}(${FOUND_BY[loaded.how]})`);
    }

    const persona = await choosePersona(flags);
    log(`口調: ${persona?.name ?? "丁寧語"}`);
    for (const issue of checkScript(report.raw, { persona, facts, seconds: flags.seconds }).issues) {
      log(`注意: ${issue.at}: ${issue.message}`);
    }
    const mismatch = flags.voice ? personaMismatch(report.persona, flags.speaker) : undefined;
    if (mismatch) log(`注意: ${mismatch}`);

    const { synth, fallback } = await createSynthesizer(flags);
    if (fallback) log(`注意: ${fallback}`);

    const { outFile, workDir } = resolveRenderPaths({
      report: reportPath,
      title: report.script.title,
      out: flags.out,
      videoDir: flags.videoDir,
    });
    await mkdir(workDir, { recursive: true });
    await mkdir(path.dirname(outFile), { recursive: true });
    const result = await renderReport(
      {
        script: report.script,
        facts,
        author: report.author,
        persona: persona ? { id: persona.id, name: persona.name } : report.persona,
      },
      {
        outFile,
        workDir,
        synth,
        speed: flags.speed,
        maxSpeed: MAX_SPEED,
        maxSeconds: flags.seconds * LENGTH_TOLERANCE,
        fps: flags.fps,
        chromiumPath: flags.chromium,
        timeZone: flags.timezone,
        onSpeechProgress: progress(flags.voice && !fallback ? "音声合成" : "字幕の時間割り当て"),
        onFrameProgress: progress("描画"),
      },
    );
    log(
      `完了: ${result.outFile}(${result.duration.toFixed(1)} 秒、話速 ${result.speed}` +
        `、撮影 ${result.stats.captured}/${result.stats.frames} フレーム)`,
    );
    if (fallback) {
      log(`注意: 読み上げなし(字幕のみ)で作成しました。描画し直すには: ${commandLine(["dopagakix", "render", displayPath(result.scriptFile)])}`);
    }
    if (result.credit) log(`クレジット表記: ${result.credit}(VOICEVOX の利用規約により必要です)`);
    process.stdout.write(`${result.outFile}\n`);
  });

withSessionOptions(program.command("digest").description("セッションログを時系列のダイジェストにする(作業の振り返り用)"))
  .option("-o, --out <file>", "書き出し先(省略時は標準出力)")
  .option("--max-digest-chars <n>", "ダイジェストの最大文字数。超える場合はツールの出力から順に削る", positiveInteger, DEFAULT_MAX_DIGEST_CHARS)
  .option("--timezone <tz>", "時刻表示のタイムゾーン(例: Asia/Tokyo)")
  .action(async (flags: SessionFlags & { out?: string; maxDigestChars: number; timezone?: string }) => {
    const result = await digestSession({ ...locateOptions(flags), maxDigestChars: flags.maxDigestChars, timeZone: flags.timezone });
    const notes = [
      `${result.digest.length.toLocaleString()} 文字`,
      result.level > 0 ? `文字数に合わせて要約度 ${result.level}` : undefined,
      result.omittedLines > 0 ? `${result.omittedLines} 行を省略` : undefined,
      result.redactions > 0 ? `秘匿情報らしき文字列 ${result.redactions} 件をマスク` : undefined,
    ].filter(Boolean);
    log(`ログ: ${result.file}`);
    log(`ダイジェスト: ${notes.join("、")}`);
    if (flags.out) {
      await mkdir(path.dirname(path.resolve(flags.out)), { recursive: true });
      await writeFile(flags.out, result.digest);
      log(`書き出しました: ${path.resolve(flags.out)}`);
    } else {
      process.stdout.write(result.digest);
    }
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
  .addOption(new Option("--voicevox-url <url>", "VOICEVOX エンジンの URL").default(DEFAULT_VOICEVOX_URL).env("VOICEVOX_URL"))
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

program
  .command("install-skill")
  .description(`Claude Code 用のスキル(${SKILL_NAME})を導入する。「動画で報告して」と頼むとエージェントが使う`)
  .option("-p, --project <dir>", "導入先のプロジェクト(<dir>/.claude/skills に入れる)", process.cwd())
  .option("--user", "個人用(~/.claude/skills)に入れ、すべてのプロジェクトで使えるようにする")
  .option("--force", "内容の異なる既存のスキルを上書きする")
  .action(async (flags: { project: string; user?: boolean; force?: boolean }) => {
    const target = skillsDir({ user: Boolean(flags.user), projectDir: flags.project });
    const newDirectory = !existsSync(target);
    const result = await installSkill({ target, force: flags.force });
    log({ installed: "導入しました", updated: "更新しました", unchanged: "既に同じ内容です" }[result.status] + `: ${result.dir}`);
    if (newDirectory) {
      log("実行中の Claude Code のセッションで使うには /reload-skills を実行してください(新しいセッションでは自動で読み込まれます)。");
    }
    process.stdout.write(`${result.dir}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  log(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.DEBUG && error instanceof Error && error.stack) log(error.stack);
  process.exitCode = 1;
});
