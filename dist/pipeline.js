import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { redactSecrets } from "./redact.js";
import { normalizeScript } from "./script/normalize.js";
import { ScriptFileSchema, VideoScriptSchema } from "./script/schema.js";
import { SilentSynthesizer } from "./tts/silent.js";
import { VoicevoxConnectionError, VoicevoxSynthesizer } from "./tts/voicevox.js";
import { encodeWav } from "./tts/wav.js";
import { buildDigest, collectFacts } from "./transcript/digest.js";
import { locateTranscript } from "./transcript/locate.js";
import { readTranscript } from "./transcript/parse.js";
import { renderVideo } from "./video/render.js";
import { buildHtml } from "./video/template.js";
import { buildTimeline } from "./video/timeline.js";
/** 動画と作業ファイルの出力先(既定) */
export const DEFAULT_OUT_DIR = "dopagakix-out";
/**
 * 報告のために書いたファイル(台本など)を、作業の成果として数えないよう集計から除く。
 * 既定の出力先(dopagakix-out)の中と、指定したディレクトリの中にあるファイルが対象。
 */
export function excludeOutputs(facts, dirs = []) {
    const base = facts.cwd ?? process.cwd();
    const roots = dirs.map((dir) => path.resolve(dir));
    const isOutput = (file) => {
        const absolute = path.resolve(base, file);
        return (absolute.split(path.sep).includes(DEFAULT_OUT_DIR) ||
            roots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`)));
    };
    const files = facts.files.filter((file) => !isOutput(file.path));
    return files.length === facts.files.length ? facts : { ...facts, files };
}
/**
 * セッションログを探して読み、画面に出す数値を集計する。
 * outputDirs には、報告の台本などを置くディレクトリを渡す(集計から除く)。
 */
export async function loadSession(options, outputDirs = []) {
    const located = await locateTranscript(options);
    const session = await readTranscript(located.file);
    const sessionId = session.sessionId ?? path.basename(located.file, ".jsonl");
    return { ...located, session, facts: excludeOutputs(collectFacts(session), outputDirs), sessionId };
}
/** セッションログを、振り返り用のダイジェスト(時系列の要約)にする。 */
export async function digestSession(options) {
    const { file, session, facts } = await loadSession(options);
    const digest = buildDigest(session, facts, { maxChars: options.maxDigestChars, timeZone: options.timeZone });
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
function formatError(file, error) {
    return new Error(`${file} の形式が正しくありません:\n${z.prettifyError(error)}`);
}
/**
 * 台本を読む。エージェントが書いた台本(report.json)と、描画したときに残す script.json の
 * どちらも受け付ける。後者には事実情報が入っているので、同じ内容で描画し直せる。
 */
export async function loadReport(file) {
    let json;
    try {
        json = JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        throw new Error(`${file} を JSON として読めません: ${error.message}`);
    }
    if (json !== null && typeof json === "object" && "version" in json) {
        const parsed = ScriptFileSchema.safeParse(json);
        if (!parsed.success)
            throw formatError(file, parsed.error);
        const { script, author, facts, persona } = parsed.data;
        return { raw: script, script: normalizeScript(script), author, facts, persona };
    }
    const parsed = VideoScriptSchema.safeParse(json);
    if (!parsed.success)
        throw formatError(file, parsed.error);
    return { raw: parsed.data, script: normalizeScript(parsed.data), author: "agent" };
}
/**
 * 読み上げに使う合成器を選ぶ。VOICEVOX に接続できないときは、作業を止めないよう
 * 字幕のみに切り替える(話者 ID の誤りなど、設定の誤りはエラーにする)。
 */
export async function createSynthesizer(options) {
    if (!options.voice)
        return { synth: new SilentSynthesizer() };
    try {
        const synth = await VoicevoxSynthesizer.create({
            baseUrl: options.voicevoxUrl,
            speaker: options.speaker,
            credit: options.credit,
            fetch: options.fetch,
        });
        return { synth };
    }
    catch (error) {
        if (!(error instanceof VoicevoxConnectionError))
            throw error;
        return {
            synth: new SilentSynthesizer(),
            fallback: `VOICEVOX エンジン(${options.voicevoxUrl})に接続できないため、字幕のみで作成します。読み上げを付けるには、エンジンを起動してから描画し直してください。`,
        };
    }
}
/** 出力先を作り、中身を git の管理対象から外す(pytest のキャッシュと同じく、.gitignore に * を書く)。 */
export async function prepareOutputRoot(dir) {
    await mkdir(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if (!existsSync(ignore))
        await writeFile(ignore, "# dopagakix が作成。動画と作業ファイルを git の管理対象から外す\n*\n");
}
/** 台本から音声と映像を作り、mp4 に書き出す。 */
export async function renderReport(input, options) {
    const record = {
        version: 1,
        generatedAt: new Date().toISOString(),
        author: input.author,
        ...(input.persona ? { persona: input.persona } : {}),
        facts: input.facts,
        script: input.script,
    };
    const scriptFile = path.join(options.workDir, "script.json");
    await writeFile(scriptFile, `${JSON.stringify(record, null, 2)}\n`);
    const timeline = await buildTimeline(input.script, options.synth, {
        maxSeconds: options.maxSeconds,
        speed: options.speed,
        maxSpeed: options.maxSpeed,
        onProgress: options.onSpeechProgress,
    });
    const audioFile = path.join(options.workDir, "narration.wav");
    await writeFile(audioFile, encodeWav(timeline.audio));
    await writeFile(path.join(options.workDir, "timeline.json"), `${JSON.stringify({ duration: timeline.duration, speed: timeline.speed, credit: timeline.credit, scenes: timeline.scenes }, null, 2)}\n`);
    const html = buildHtml({
        script: input.script,
        facts: input.facts,
        scenes: timeline.scenes,
        credit: timeline.credit,
        author: input.author,
        timeZone: options.timeZone,
    });
    const stats = await renderVideo(html, {
        outFile: options.outFile,
        audioFile,
        duration: timeline.duration,
        fps: options.fps,
        scale: options.scale,
        chromiumPath: options.chromiumPath,
        onProgress: options.onFrameProgress,
    });
    return {
        outFile: options.outFile,
        scriptFile,
        duration: timeline.duration,
        speed: timeline.speed,
        credit: timeline.credit,
        stats,
    };
}
