import type { VideoScript } from "../script/schema.js";
import type { Synthesizer } from "../tts/types.js";
import { durationOf, mixInto, type Pcm, silence } from "../tts/wav.js";

export const SCENE_KINDS = ["opening", "request", "work", "verification", "decisions", "closing"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** 字幕 1 枚分。start〜end は読み上げ音声が鳴っている区間(秒)。 */
export interface Cue {
  text: string;
  start: number;
  end: number;
}

export interface TimedScene {
  kind: SceneKind;
  start: number;
  end: number;
  cues: Cue[];
}

export interface Timeline {
  scenes: TimedScene[];
  duration: number;
  audio: Pcm;
  /** 実際に使った話速 */
  speed: number;
  credit: string | undefined;
}

export interface TimelineOptions {
  /** これを超えたら話速を上げて収める(秒) */
  maxSeconds: number;
  speed: number;
  maxSpeed: number;
  onProgress?: (done: number, total: number) => void;
}

/** シーン開始から最初の読み上げまで。要素の登場アニメーションを見せる時間。 */
const LEAD_IN = 0.5;
/** 文と文の間。0.25 秒では間延びしたため詰めている */
const LINE_GAP = 0.15;
const TAIL = 0.6;
/** 最後のシーンはクレジットを読めるよう長めに残す */
const CLOSING_TAIL = 2.0;
const MIN_SCENE = 2.4;
/** 字幕 2 行(46px・幅 888px)に収まる目安(全角) */
const CAPTION_MAX = 38;

/** 字幕が 2 行に収まるよう、長い文を文末・読点のうち中央に近い位置で分ける。 */
export function splitCaption(text: string, max = CAPTION_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const middle = trimmed.length / 2;
  let best = -1;
  for (const pattern of [/[。!?!?]/g, /[、,]/g]) {
    for (const match of trimmed.matchAll(pattern)) {
      const position = match.index + 1;
      if (position >= trimmed.length) continue;
      if (best < 0 || Math.abs(position - middle) < Math.abs(best - middle)) best = position;
    }
    if (best > 0) break;
  }
  if (best <= 0) best = Math.ceil(middle);
  return [...splitCaption(trimmed.slice(0, best), max), ...splitCaption(trimmed.slice(best), max)];
}

export function sceneLines(script: VideoScript): Array<{ kind: SceneKind; lines: string[] }> {
  const narration: Record<SceneKind, string[]> = {
    opening: script.opening.narration,
    request: script.request.narration,
    work: script.work.narration,
    verification: script.verification.narration,
    decisions: script.decisions.narration,
    closing: script.next_steps.narration,
  };
  return SCENE_KINDS.map((kind) => ({ kind, lines: narration[kind].flatMap((line) => splitCaption(line)) }));
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

function layout(scenes: Array<{ kind: SceneKind; lines: string[] }>, clips: Pcm[][]): { scenes: TimedScene[]; duration: number } {
  let cursor = 0;
  const timed = scenes.map((scene, i) => {
    const start = cursor;
    let at = start + LEAD_IN;
    const cues = scene.lines.map((text, j) => {
      const length = durationOf(clips[i]![j]!);
      const cue = { text, start: round(at), end: round(at + length) };
      at += length + LINE_GAP;
      return cue;
    });
    const speechEnd = cues.at(-1)?.end ?? start;
    const tail = scene.kind === "closing" ? CLOSING_TAIL : TAIL;
    const end = round(Math.max(start + MIN_SCENE, speechEnd + tail));
    cursor = end;
    return { kind: scene.kind, start, end, cues };
  });
  return { scenes: timed, duration: cursor };
}

/**
 * 読み上げ音声を合成し、その長さからシーンと字幕の時刻を決める。
 * 全体が maxSeconds を超える場合は、話速を maxSpeed まで上げて一度だけ作り直す。
 */
export async function buildTimeline(script: VideoScript, synth: Synthesizer, options: TimelineOptions): Promise<Timeline> {
  const scenes = sceneLines(script);
  const total = scenes.reduce((n, scene) => n + scene.lines.length, 0);

  const synthesizeAll = async (speed: number) => {
    let done = 0;
    const clips: Pcm[][] = [];
    for (const scene of scenes) {
      const sceneClips: Pcm[] = [];
      for (const line of scene.lines) {
        sceneClips.push(await synth.synthesize(line, speed));
        options.onProgress?.(++done, total);
      }
      clips.push(sceneClips);
    }
    return clips;
  };

  let speed = options.speed;
  let clips = await synthesizeAll(speed);
  let timed = layout(scenes, clips);

  if (timed.duration > options.maxSeconds && speed < options.maxSpeed) {
    // 読み上げ時間は話速にほぼ反比例するので、超過分を吸収できる話速を求める
    const speech = clips.flat().reduce((sum, clip) => sum + durationOf(clip), 0);
    const excess = timed.duration - options.maxSeconds;
    const needed = speech > excess ? (speed * speech) / (speech - excess) : options.maxSpeed;
    speed = Math.min(options.maxSpeed, Math.ceil(needed * 100) / 100);
    clips = await synthesizeAll(speed);
    timed = layout(scenes, clips);
  }

  const first = clips.flat()[0];
  const audio = silence(timed.duration, first?.sampleRate ?? 24_000, first?.channels ?? 1);
  timed.scenes.forEach((scene, i) => {
    scene.cues.forEach((cue, j) => mixInto(audio, clips[i]![j]!, cue.start));
  });

  return { scenes: timed.scenes, duration: timed.duration, audio, speed, credit: synth.credit };
}
