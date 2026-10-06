import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SessionFacts } from "./facts.js";
import { redactSecrets } from "./redact.js";
import { type Effort, generateScript } from "./script/generate.js";
import { normalizeScript } from "./script/normalize.js";
import { type ScriptFile, ScriptFileSchema } from "./script/schema.js";
import { SilentSynthesizer } from "./tts/silent.js";
import { VoicevoxSynthesizer } from "./tts/voicevox.js";
import { encodeWav } from "./tts/wav.js";
import { buildDigest } from "./transcript/digest.js";
import { collectFacts } from "./transcript/digest.js";
import { locateTranscript } from "./transcript/locate.js";
import { readTranscript } from "./transcript/parse.js";
import { type RenderStats, renderVideo } from "./video/render.js";
import { buildHtml } from "./video/template.js";
import { buildTimeline } from "./video/timeline.js";

export interface SessionInput {
  transcript?: string;
  session?: string;
  projectDir: string;
  maxDigestChars: number;
  timeZone?: string;
}

export interface DigestResult {
  file: string;
  facts: SessionFacts;
  /** 秘匿情報をマスク済みのダイジェスト */
  digest: string;
  level: number;
  omittedLines: number;
  redactions: number;
}

/** セッションログを探して読み、LLM に渡すダイジェストを作る(API は呼ばない)。 */
export async function digestSession(input: SessionInput): Promise<DigestResult> {
  const file = await locateTranscript(input);
  const session = await readTranscript(file);
  const facts = collectFacts(session);
  const digest = buildDigest(session, facts, { maxChars: input.maxDigestChars, timeZone: input.timeZone });
  const redacted = redactSecrets(digest.text);
  return {
    file,
    facts,
    digest: redacted.text,
    level: digest.level,
    omittedLines: digest.omittedLines,
    redactions: redacted.count,
  };
}

export interface ScriptOptions {
  model: string;
  effort: Effort;
  seconds: number;
  fallback: boolean;
}

/** ダイジェストから台本を作り、事実情報とまとめて script.json の形にする。 */
export async function createScriptFile(digest: DigestResult, options: ScriptOptions): Promise<ScriptFile> {
  const result = await generateScript(digest.digest, {
    model: options.model,
    effort: options.effort,
    targetSeconds: options.seconds,
    fallback: options.fallback,
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    facts: digest.facts,
    script: result.script,
  };
}

export async function loadScriptFile(file: string): Promise<ScriptFile> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} を JSON として読めません: ${(error as Error).message}`);
  }
  const parsed = ScriptFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${file} の形式が正しくありません:\n${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, script: normalizeScript(parsed.data.script) };
}

/** 手書きの台本であることを示す generator.model の値 */
export const MANUAL_GENERATOR = "manual";

export interface RenderPipelineOptions {
  outFile: string;
  /** narration.wav と timeline.json を置く場所 */
  workDir: string;
  voice: boolean;
  speaker: number;
  voicevoxUrl: string;
  speed: number;
  maxSpeed: number;
  maxSeconds: number;
  fps: number;
  chromiumPath?: string;
  timeZone?: string;
  onSpeechProgress?: (done: number, total: number) => void;
  onFrameProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  outFile: string;
  duration: number;
  speed: number;
  credit: string | undefined;
  stats: RenderStats;
}

/** 台本から音声と映像を作り、mp4 に書き出す。 */
export async function renderScriptFile(file: ScriptFile, options: RenderPipelineOptions): Promise<RenderResult> {
  const synth = options.voice
    ? await VoicevoxSynthesizer.create({ baseUrl: options.voicevoxUrl, speaker: options.speaker })
    : new SilentSynthesizer();
  const timeline = await buildTimeline(file.script, synth, {
    maxSeconds: options.maxSeconds,
    speed: options.speed,
    maxSpeed: options.maxSpeed,
    onProgress: options.onSpeechProgress,
  });

  const audioFile = path.join(options.workDir, "narration.wav");
  await writeFile(audioFile, encodeWav(timeline.audio));
  await writeFile(
    path.join(options.workDir, "timeline.json"),
    `${JSON.stringify({ duration: timeline.duration, speed: timeline.speed, credit: timeline.credit, scenes: timeline.scenes }, null, 2)}\n`,
  );

  const html = buildHtml({
    script: file.script,
    facts: file.facts,
    scenes: timeline.scenes,
    credit: timeline.credit,
    summarizer: file.generator && file.generator.model !== MANUAL_GENERATOR ? file.generator.model : undefined,
    timeZone: options.timeZone,
  });
  const stats = await renderVideo(html, {
    outFile: options.outFile,
    audioFile,
    duration: timeline.duration,
    fps: options.fps,
    chromiumPath: options.chromiumPath,
    onProgress: options.onFrameProgress,
  });
  return { outFile: options.outFile, duration: timeline.duration, speed: timeline.speed, credit: timeline.credit, stats };
}
