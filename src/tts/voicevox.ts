import type { Synthesizer } from "./types.js";
import { type Pcm, parseWav } from "./wav.js";

export const DEFAULT_VOICEVOX_URL = "http://127.0.0.1:50021";
/** ずんだもん(ノーマル) */
export const DEFAULT_SPEAKER = 3;

export interface VoicevoxSpeaker {
  name: string;
  speaker_uuid: string;
  styles: Array<{ name: string; id: number; type?: string }>;
}

export class VoicevoxError extends Error {
  override name = "VoicevoxError";
}

/** エンジンに接続できない(起動していない、URL が違う)。字幕のみに切り替える判断に使う。 */
export class VoicevoxConnectionError extends VoicevoxError {
  override name = "VoicevoxConnectionError";
}

/** VOICEVOX ENGINE の HTTP API のうち、本ツールが使う部分。 */
export class VoicevoxClient {
  constructor(
    readonly baseUrl: string = DEFAULT_VOICEVOX_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new VoicevoxConnectionError(
        `VOICEVOX エンジン(${this.baseUrl})に接続できません。エンジンを起動するか、--no-voice を指定してください。`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new VoicevoxError(`VOICEVOX エンジンがエラーを返しました(${response.status} ${path}): ${body.slice(0, 300)}`);
    }
    return response;
  }

  async version(): Promise<string> {
    return (await (await this.request("/version")).json()) as string;
  }

  async speakers(): Promise<VoicevoxSpeaker[]> {
    return (await (await this.request("/speakers")).json()) as VoicevoxSpeaker[];
  }

  async initializeSpeaker(speaker: number): Promise<void> {
    await this.request(`/initialize_speaker?speaker=${speaker}&skip_reinit=true`, { method: "POST" });
  }

  async audioQuery(text: string, speaker: number): Promise<Record<string, unknown>> {
    // enable_katakana_english: 英単語をカタカナ読みに変換させる(無効だと 1 文字ずつ読み上げる)
    const params = new URLSearchParams({ text, speaker: String(speaker), enable_katakana_english: "true" });
    return (await (await this.request(`/audio_query?${params}`, { method: "POST" })).json()) as Record<string, unknown>;
  }

  async synthesis(query: Record<string, unknown>, speaker: number): Promise<Buffer> {
    const response = await this.request(`/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    return Buffer.from(await response.arrayBuffer());
  }
}

export interface VoicevoxOptions {
  baseUrl?: string;
  speaker?: number;
  fetch?: typeof fetch;
}

export class VoicevoxSynthesizer implements Synthesizer {
  private constructor(
    private readonly client: VoicevoxClient,
    private readonly speaker: number,
    readonly credit: string,
  ) {}

  /** エンジンへの接続と話者の存在を確かめてから作る。 */
  static async create(options: VoicevoxOptions = {}): Promise<VoicevoxSynthesizer> {
    const client = new VoicevoxClient(options.baseUrl ?? DEFAULT_VOICEVOX_URL, options.fetch);
    const speaker = options.speaker ?? DEFAULT_SPEAKER;
    const speakers = await client.speakers();
    const owner = speakers.find((s) => s.styles.some((style) => style.id === speaker));
    if (!owner) {
      throw new VoicevoxError(`話者 ID ${speaker} はこのエンジンにありません。\`dopagakix speakers\` で一覧を確認してください。`);
    }
    await client.initializeSpeaker(speaker);
    // VOICEVOX の利用規約で求められるクレジット表記
    return new VoicevoxSynthesizer(client, speaker, `VOICEVOX:${owner.name}`);
  }

  async synthesize(text: string, speed: number): Promise<Pcm> {
    const query = await this.client.audioQuery(text, this.speaker);
    query.speedScale = speed;
    // 文頭・文末の無音は字幕の切り替えに合わせて自前で入れるため短くする
    query.prePhonemeLength = 0.05;
    query.postPhonemeLength = 0.05;
    return parseWav(await this.client.synthesis(query, this.speaker));
  }
}
