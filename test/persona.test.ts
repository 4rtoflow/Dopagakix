import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkEndings, findPersona, personaMismatch, resolvePersona, ZUNDAMON } from "../src/persona.js";

const speakersResponse = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  if (url.pathname !== "/speakers") return new Response("not found", { status: 404 });
  return Response.json([
    { name: "ずんだもん", speaker_uuid: "z", styles: [{ name: "ノーマル", id: 3 }, { name: "なみだめ", id: 76 }] },
    { name: "青山龍星", speaker_uuid: "a", styles: [{ name: "ノーマル", id: 13 }] },
  ]);
}) as typeof fetch;

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

describe("findPersona", () => {
  it("話者名で選び、名前が分からなければスタイル ID で選ぶ", () => {
    expect(findPersona({ id: 999, name: "ずんだもん" })?.id).toBe("zundamon");
    expect(findPersona({ id: 75 })?.id).toBe("zundamon");
    expect(findPersona({ id: 13, name: "青山龍星" })).toBeUndefined();
  });
});

describe("resolvePersona", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("auto は話者から口調を選ぶ(エンジンが動いていなくても ID で判定)", async () => {
    const base = { option: "auto", voice: true, voicevoxUrl: "http://127.0.0.1:50021" };
    expect((await resolvePersona({ ...base, speaker: 3, fetch: speakersResponse }))?.name).toBe("ずんだもん");
    expect(await resolvePersona({ ...base, speaker: 13, fetch: speakersResponse })).toBeUndefined();
    expect((await resolvePersona({ ...base, speaker: 76, fetch: unreachable }))?.name).toBe("ずんだもん");
  });

  it("none と読み上げなしでは口調を付けない", async () => {
    expect(await resolvePersona({ option: "none", speaker: 3, voice: true })).toBeUndefined();
    expect(await resolvePersona({ option: "auto", speaker: 3, voice: false })).toBeUndefined();
  });

  it("組み込みの ID と JSON ファイルを指定できる", async () => {
    expect((await resolvePersona({ option: "zundamon", speaker: 13, voice: true }))?.id).toBe("zundamon");

    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-persona-"));
    const file = path.join(dir, "metan.json");
    await writeFile(file, JSON.stringify({ id: "custom", name: "カスタム", style: "語尾に「〜ですわ」を付ける。" }));
    const custom = await resolvePersona({ option: file, speaker: 2, voice: true });
    expect(custom).toMatchObject({ id: "custom", name: "カスタム", speakerNames: [], examples: [] });

    const broken = path.join(dir, "broken.json");
    await writeFile(broken, JSON.stringify({ id: "x" }));
    await expect(resolvePersona({ option: broken, speaker: 2, voice: true })).rejects.toThrow(/形式が正しくありません/);

    const badPattern = path.join(dir, "bad-pattern.json");
    await writeFile(badPattern, JSON.stringify({ id: "x", name: "x", style: "x", endingPattern: "(のだ" }));
    await expect(resolvePersona({ option: badPattern, speaker: 2, voice: true })).rejects.toThrow(/正規表現/);

    await expect(resolvePersona({ option: "metan", speaker: 2, voice: true })).rejects.toThrow(/見つかりません.*zundamon/);
  });

  it("台本の口調と話者の食い違いを検出する", () => {
    expect(personaMismatch({ id: "zundamon", name: "ずんだもん" }, 13)).toMatch(/話者 ID 13 はずんだもんではありません/);
    expect(personaMismatch({ id: "zundamon", name: "ずんだもん" }, 76)).toBeUndefined();
    expect(personaMismatch(undefined, 13)).toBeUndefined();
    expect(personaMismatch({ id: "custom", name: "カスタム" }, 13)).toBeUndefined();
  });
});

describe("checkEndings", () => {
  it("口調どおりの文末になっていない文を挙げる", () => {
    const result = checkEndings(
      ["修正が終わったのだ。", "全部通ったなのだ!", "テストも書いたのだよ。", "確認をお願いします。"],
      ZUNDAMON,
    );
    expect(result).toEqual({ checked: 4, misses: ["確認をお願いします。"] });
  });
});
