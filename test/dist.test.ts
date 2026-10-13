import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(dir, relative)));
    else files.push(relative);
  }
  return files.sort();
}

/*
 * npm install -g github:… で導入できるよう、ビルド済みの dist/ をコミットしている
 * (npm は git から入れるパッケージのビルドを、グローバル導入の時にうまく行えないため。README の「開発」を参照)。
 * ソースを変えて npm run compile を忘れると、古い dist/ が配布されてしまうので、ここで検出する。
 */
describe("dist/", () => {
  let out: string | undefined;
  afterAll(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it("ソースからビルドした結果と一致する(違う場合は npm run compile してコミットする)", async () => {
    out = await mkdtemp(path.join(os.tmpdir(), "dopagakix-dist-"));
    const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    execFileSync(tsc, ["-p", "tsconfig.build.json", "--outDir", out], { cwd: root, stdio: "pipe" });

    const built = await listFiles(out);
    expect(await listFiles(path.join(root, "dist"))).toEqual(built);
    for (const file of built) {
      const [expected, actual] = await Promise.all([readFile(path.join(out, file), "utf8"), readFile(path.join(root, "dist", file), "utf8")]);
      expect(actual, `dist/${file} が古いままです`).toBe(expected);
    }
  });
});
