import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { VoicevoxConnectionError, VoicevoxError } from "./voicevox.js";
/** 起動コマンドを実行してから、エンジンが応答するまで待つ時間の上限 */
export const START_TIMEOUT_MS = 60_000;
async function responds(baseUrl, fetchImpl) {
    try {
        return (await fetchImpl(new URL("/version", baseUrl), { signal: AbortSignal.timeout(2000) })).ok;
    }
    catch {
        return false;
    }
}
/** コマンドの出力の末尾を 1 行にまとめる(prepare の「環境」の箇条書きに収めるため) */
function outputOf(file) {
    try {
        const text = readFileSync(file, "utf8").trim();
        return text ? ` 出力(${file} の末尾): ${text.slice(-500).replace(/\s*\n\s*/g, " / ")}` : "";
    }
    catch {
        return "";
    }
}
/**
 * VOICEVOX エンジンの起動コマンドを実行し、/version に応答するまで待つ。
 * コマンドは docker start のようにすぐ終わるものでも、エンジンそのもの(終わらない)でもよい。
 * dopagakix が終わってもエンジンが動き続けるよう別のプロセスグループで起動し、出力はファイルに書かせる
 * (パイプにすると、dopagakix の終了後にエンジンの書き込みが失敗しうるため)。
 */
export async function startVoicevox(options) {
    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
    const logFile = options.logFile ?? path.join(os.tmpdir(), "dopagakix-voicevox-start.log");
    const label = `VOICEVOX エンジンの起動コマンド(DOPAGAKIX_VOICEVOX_START: ${options.command})`;
    let exit;
    let failure;
    const fd = openSync(logFile, "w");
    try {
        const child = spawn(options.command, { shell: true, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
        child.on("exit", (code, signal) => {
            exit = { ok: code === 0, how: code === null ? `シグナル ${signal}` : `終了コード ${code}` };
        });
        child.on("error", (error) => {
            failure = error;
        });
        child.unref();
    }
    finally {
        closeSync(fd);
    }
    const startedAt = Date.now();
    const waited = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`;
    for (;;) {
        if (await responds(options.baseUrl, fetchImpl))
            return;
        if (failure)
            throw new VoicevoxError(`${label}を実行できません: ${failure.message}`);
        if (exit && !exit.ok)
            throw new VoicevoxError(`${label}が${exit.how} で終わりました(${waited()}待機)。${outputOf(logFile)}`);
        if (Date.now() - startedAt >= timeoutMs) {
            throw new VoicevoxError(`${label}を実行して ${waited()}待ちましたが、エンジン(${options.baseUrl})が応答しません。${outputOf(logFile)}`);
        }
        await sleep(options.intervalMs ?? 500);
    }
}
/** run を実行し、エンジンに接続できなければ、起動コマンドでエンジンを起動してからもう一度実行する。 */
export async function withVoicevoxStart(run, start) {
    try {
        return await run();
    }
    catch (error) {
        if (!(error instanceof VoicevoxConnectionError) || !start.command)
            throw error;
    }
    start.onStart?.(start.command);
    await startVoicevox({ command: start.command, baseUrl: start.baseUrl, fetch: start.fetch });
    return run();
}
