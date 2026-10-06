import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

/** Playwright のブラウザキャッシュ内で実行ファイルが置かれる相対パス(OS・版ごとに異なる) */
const EXECUTABLES = [
  "chrome-linux/headless_shell",
  "chrome-headless-shell-linux64/chrome-headless-shell",
  "chrome-linux64/chrome",
  "chrome-linux/chrome",
  "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "chrome-headless-shell-mac-x64/chrome-headless-shell",
  "chrome-mac/headless_shell",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-headless-shell-win64/chrome-headless-shell.exe",
  "chrome-win/headless_shell.exe",
  "chrome-win64/chrome.exe",
  "chrome-win/chrome.exe",
];

const SYSTEM_BROWSERS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

function cacheRoots(): string[] {
  const home = os.homedir();
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, ".cache", "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
  ].filter((root): root is string => Boolean(root) && existsSync(root!));
}

function revision(dir: string): number {
  return Number(/-(\d+)$/.exec(dir)?.[1] ?? 0);
}

/**
 * 描画に使う Chromium を探す。優先順: 明示指定 → 環境変数 DOPAGAKIX_CHROMIUM →
 * playwright-core が想定する版 → Playwright のキャッシュにある他の版 → システムの Chrome。
 */
export function resolveChromium(explicit?: string): string {
  const requested = explicit ?? process.env.DOPAGAKIX_CHROMIUM;
  if (requested) {
    if (!existsSync(requested)) throw new Error(`指定されたブラウザが見つかりません: ${requested}`);
    return requested;
  }

  const expected = chromium.executablePath();
  if (expected && existsSync(expected)) return expected;

  for (const root of cacheRoots()) {
    const dirs = readdirSync(root)
      .filter((dir) => /^chromium(_headless_shell)?-\d+$/.test(dir))
      // 新しい版を優先し、同じ版なら軽い headless shell を選ぶ
      .sort((a, b) => revision(b) - revision(a) || Number(b.includes("headless")) - Number(a.includes("headless")));
    for (const dir of dirs) {
      for (const executable of EXECUTABLES) {
        const candidate = path.join(root, dir, executable);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  const system = SYSTEM_BROWSERS.find((candidate) => existsSync(candidate));
  if (system) return system;

  throw new Error(
    "描画用の Chromium が見つかりません。`npx playwright-core install --only-shell chromium` を実行するか、--chromium でパスを指定してください。",
  );
}
