import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveChromium } from "./browser.js";
import { VIDEO_HEIGHT, VIDEO_WIDTH } from "./template.js";
/** ページを配信する架空のオリジン。実際の通信は page.route で横取りする。 */
const ORIGIN = "http://dopagakix.invalid";
/** 描画に使うフォントの npm パッケージ(ページからは /fonts/<キー>/ で読む) */
export const FONT_PACKAGES = {
    serif: "@fontsource-variable/noto-serif-jp",
    gothic: "@fontsource/zen-kaku-gothic-new",
    mono: "@fontsource-variable/jetbrains-mono",
};
/** パッケージのディレクトリ。見つからなければ例外 */
export function packageDir(name) {
    return path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
}
function fontDirectories() {
    return Object.fromEntries(Object.entries(FONT_PACKAGES).map(([key, name]) => [key, packageDir(name)]));
}
function even(n) {
    return Math.max(2, Math.round(n / 2) * 2);
}
function startFfmpeg(args) {
    const ffmpeg = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
    });
    // ffmpeg が先に落ちた場合の EPIPE は done 側で報告する
    ffmpeg.stdin.on("error", () => { });
    const done = new Promise((resolve, reject) => {
        ffmpeg.on("error", (error) => reject(new Error(`ffmpeg を起動できません(${error.message})。ffmpeg をインストールしてください。`)));
        ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg が失敗しました(終了コード ${code})\n${stderr}`))));
    });
    // 撮影側の失敗で done を待たずに抜けた場合でも、未処理の reject にしない
    done.catch(() => { });
    return { stdin: ffmpeg.stdin, done };
}
async function write(stream, chunk, done) {
    if (stream.write(chunk))
        return;
    await Promise.race([once(stream, "drain"), done]);
}
/**
 * HTML を Chromium で 1 フレームずつ描き、ffmpeg で H.264/AAC の mp4 にする。
 * アニメーションはページ側の __seek(t) で時刻を指定して止めた状態を撮るため、
 * 描画速度に左右されず毎回同じ結果になる。
 */
export async function renderVideo(html, options) {
    const fps = options.fps ?? 30;
    const scale = options.scale ?? 1;
    const width = even(VIDEO_WIDTH * scale);
    const height = even(VIDEO_HEIGHT * scale);
    const fonts = fontDirectories();
    const browser = await chromium.launch({
        executablePath: resolveChromium(options.chromiumPath),
        args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"],
    });
    try {
        const page = await browser.newPage({ viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } });
        await page.route(`${ORIGIN}/**`, async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === "/index.html") {
                return route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
            }
            const match = /^\/fonts\/(serif|gothic|mono)\/(.+)$/.exec(url.pathname);
            const root = match ? fonts[match[1]] : undefined;
            if (match && root) {
                const file = path.resolve(root, decodeURIComponent(match[2]));
                if (file.startsWith(root + path.sep))
                    return route.fulfill({ path: file });
            }
            return route.fulfill({ status: 404, body: "not found" });
        });
        await page.goto(`${ORIGIN}/index.html`);
        const fitScales = await page.evaluate(() => window.__prepare());
        // page.screenshot より CDP の高速モードの方が 3 倍ほど速い(圧縮率は下がるが、パイプで渡すだけなので問題ない)
        const cdp = await page.context().newCDPSession(page);
        // 縮小出力は撮影時に縮める(deviceScaleFactor < 1 は撮影サイズに反映されない)
        const clip = { x: 0, y: 0, width: VIDEO_WIDTH, height: VIDEO_HEIGHT, scale: width / VIDEO_WIDTH };
        const capture = async () => {
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip });
            return Buffer.from(data, "base64");
        };
        const total = Math.ceil(options.duration * fps);
        const ffmpeg = startFfmpeg([
            ...["-y", "-hide_banner", "-loglevel", "error"],
            ...["-f", "image2pipe", "-c:v", "png", "-framerate", String(fps), "-i", "pipe:0"],
            ...["-i", options.audioFile],
            ...["-map", "0:v:0", "-map", "1:a:0"],
            // RGB → YUV の変換を BT.709 で行い、そのことをメタデータにも書く(スマホでの色ずれ防止)
            ...["-vf", `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`],
            ...["-c:v", "libx264", "-preset", "medium", "-crf", String(options.crf ?? 20), "-profile:v", "high"],
            ...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"],
            ...["-r", String(fps)],
            ...["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"],
            ...["-movflags", "+faststart", "-shortest", options.outFile],
        ]);
        let frame;
        let lastKey = "";
        let captured = 0;
        try {
            for (let i = 0; i < total; i++) {
                const key = await page.evaluate((t) => window.__seek(t), i / fps);
                if (!frame || key !== lastKey) {
                    frame = await capture();
                    lastKey = key;
                    captured++;
                }
                await write(ffmpeg.stdin, frame, ffmpeg.done);
                options.onProgress?.(i + 1, total);
            }
        }
        finally {
            ffmpeg.stdin.end();
        }
        await ffmpeg.done;
        return { frames: total, captured, width, height, fitScales };
    }
    finally {
        await browser.close();
    }
}
