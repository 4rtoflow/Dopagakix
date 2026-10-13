import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { VoicevoxClient } from "./tts/voicevox.js";

/**
 * 読み上げ役のキャラクターの口調。台本生成時に Claude へ渡し、
 * 読み上げ文(と字幕)だけをその口調で書かせる。画面の見出しや項目は中立なまま。
 */
export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** この口調を適用する VOICEVOX の話者名(エンジンの /speakers の name) */
  speakerNames: z.array(z.string()).default([]),
  /** エンジンに接続できないときに使うスタイル ID */
  speakerIds: z.array(z.number().int()).default([]),
  /** Claude への口調の指示 */
  style: z.string().min(1),
  examples: z.array(z.string()).default([]),
  /** 文末の確認に使う正規表現(省略時は確認しない) */
  endingPattern: z
    .string()
    .refine((pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    }, "正規表現として解釈できません")
    .optional(),
  /** 口調の根拠 */
  source: z.string().optional(),
});

export type Persona = z.infer<typeof PersonaSchema>;

/**
 * ずんだもん。公式プロフィール(zunko.jp)に口調の記載はなく、
 * 「〜のだ/〜なのだ」「一人称ボク」は二次情報(pixiv 百科事典)に基づく。
 */
export const ZUNDAMON: Persona = {
  id: "zundamon",
  name: "ずんだもん",
  speakerNames: ["ずんだもん"],
  speakerIds: [3, 1, 7, 5, 22, 38, 75, 76],
  style:
    "一人称は「ボク」。文末は「〜のだ」「〜なのだ」にし、です・ます調は使わない" +
    "(例: しました→したのだ、です→なのだ、ください→ほしいのだ)。指示者には親しみを込めて話すが、報告の内容は正確に伝える。",
  examples: ["ログイン画面の修正が終わったのだ。", "テストは一度失敗したけど、直したら全部通ったのだ。", "プルリクエストを作っていいか、決めてほしいのだ。"],
  endingPattern: "(?:の|なの)だ(?:よ|ね)?[。!?！？]*$",
  source: "pixiv 百科事典「ずんだもん」(二次情報)",
};

export const BUILTIN_PERSONAS: Persona[] = [ZUNDAMON];

export async function loadPersonaFile(file: string): Promise<Persona> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`口調設定 ${file} を JSON として読めません: ${(error as Error).message}`);
  }
  const parsed = PersonaSchema.safeParse(json);
  if (!parsed.success) throw new Error(`口調設定 ${file} の形式が正しくありません:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function findPersona(speaker: { id: number; name?: string }, personas: Persona[] = BUILTIN_PERSONAS): Persona | undefined {
  if (speaker.name) {
    const byName = personas.find((p) => p.speakerNames.includes(speaker.name!));
    if (byName) return byName;
  }
  return personas.find((p) => p.speakerIds.includes(speaker.id));
}

export interface ResolvePersonaOptions {
  /** "auto"(話者から判断)、"none"(使わない)、組み込みの ID、または JSON ファイルのパス */
  option: string;
  speaker: number;
  /** 読み上げなしなら auto では口調を付けない */
  voice: boolean;
  voicevoxUrl?: string;
  fetch?: typeof fetch;
}

/** エンジンが動いていれば話者 ID から話者名を引く。動いていなければ undefined。 */
async function speakerName(id: number, url: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const speakers = await new VoicevoxClient(url, fetchImpl).speakers();
    return speakers.find((s) => s.styles.some((style) => style.id === id))?.name;
  } catch {
    return undefined;
  }
}

/** CLI の --persona の指定から、使う口調を決める。 */
export async function resolvePersona(options: ResolvePersonaOptions): Promise<Persona | undefined> {
  const { option } = options;
  if (option === "none") return undefined;
  if (option === "auto") {
    if (!options.voice) return undefined;
    return findPersona({ id: options.speaker, name: await speakerName(options.speaker, options.voicevoxUrl, options.fetch) });
  }
  const builtin = BUILTIN_PERSONAS.find((p) => p.id === option);
  if (builtin) return builtin;
  if (!existsSync(option)) {
    const ids = BUILTIN_PERSONAS.map((p) => p.id).join(", ");
    throw new Error(`口調「${option}」が見つかりません。auto / none / ${ids} / 口調設定の JSON ファイルを指定してください。`);
  }
  return loadPersonaFile(option);
}

/** 台本の口調と読み上げる話者が食い違っていれば、その旨の文を返す(組み込みの口調のみ判定できる)。 */
export function personaMismatch(persona: { id: string; name: string } | undefined, speaker: number): string | undefined {
  const known = BUILTIN_PERSONAS.find((p) => p.id === persona?.id);
  if (!persona || !known || known.speakerIds.includes(speaker)) return undefined;
  return `台本は${persona.name}の口調で書かれていますが、話者 ID ${speaker} は${persona.name}ではありません。`;
}

export interface EndingCheck {
  checked: number;
  /** 口調の文末になっていない文 */
  misses: string[];
}

/** 読み上げ文の文末が口調どおりかを確かめる(LLM の出力の揺れを検出するため)。 */
export function checkEndings(lines: string[], persona: Persona): EndingCheck {
  if (!persona.endingPattern) return { checked: 0, misses: [] };
  const pattern = new RegExp(persona.endingPattern);
  const misses = lines.filter((line) => !pattern.test(line.trim()));
  return { checked: lines.length, misses };
}
