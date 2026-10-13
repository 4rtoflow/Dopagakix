import { STATUS_LABELS } from "../script/schema.js";
import { formatDateTime } from "../util/time.js";
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
/*
 * デザインの方針は docs/design.md を参照。
 * 「AI が作った UI」に見えやすい要素(暗色＋光彩、格子背景、紫系の色、カードの羅列、
 * 見出し上のラベルやバッジ、側面の色帯など)を避け、紙の報告書の作法
 * (罫線、明朝の見出し、○×△、文末の「以上」)で組む。
 */
/** 状態ごとの色は彩度を抑えた「インク」の色にする */
const STATUS = {
    completed: { label: STATUS_LABELS.completed, color: "#1e7a4c", mark: "○" },
    partial: { label: STATUS_LABELS.partial, color: "#9a6200", mark: "△" },
    blocked: { label: STATUS_LABELS.blocked, color: "#c2410c", mark: "!" },
    failed: { label: STATUS_LABELS.failed, color: "#b42318", mark: "×" },
};
const CHECK = {
    pass: { label: "成功", mark: "○" },
    fail: { label: "失敗", mark: "×" },
    not_run: { label: "未実施", mark: "−" },
};
export function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
/** 長いパスは先頭側のディレクトリを省いて末尾を残す。 */
export function shortenPath(file, max = 36) {
    if (file.length <= max)
        return file;
    const parts = file.split("/");
    while (parts.length > 1 && `…/${parts.join("/")}`.length > max)
        parts.shift();
    const tail = `…/${parts.join("/")}`;
    return tail.length <= max ? tail : `…${file.slice(file.length - max + 1)}`;
}
function formatElapsed(minutes) {
    if (minutes === undefined)
        return { value: "-", unit: "" };
    if (minutes < 60)
        return { value: String(minutes), unit: "分" };
    const hours = minutes / 60;
    return { value: hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1), unit: "時間" };
}
const number = (n) => n.toLocaleString("ja-JP");
/** 大きな数は桁を丸めて枠に収める */
const compact = (n) => n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : number(n);
/** 増減の表示。0 は色を付けない */
const delta = (sign, n, format = number) => `<span class="${sign === "+" ? "plus" : "minus"}${n === 0 ? " zero" : ""}">${sign}${format(n)}</span>`;
/** 要素の登場順(アニメーションの遅延)を付ける */
const enter = (cls, i) => `class="enter ${cls}" style="--i:${i}"`;
/** 新聞の欄見出しのように、罫線の下に見出しを置く */
function sectionHead(text, attention = false) {
    return `<div class="section${attention ? " attention" : ""}"><div class="rule rule-in"></div><h2 ${enter("section-title", 0)}>${escapeHtml(text)}</h2></div>`;
}
function openingScene(script, facts, timeZone) {
    const status = STATUS[script.status];
    const added = facts.files.reduce((n, f) => n + f.added, 0);
    const removed = facts.files.reduce((n, f) => n + f.removed, 0);
    // 放置期間を含む経過時間は誤解を招くので、作業時間の推定があればそちらを出す
    const duration = formatElapsed(facts.activeMinutes ?? facts.elapsedMinutes);
    const durationLabel = facts.activeMinutes !== undefined ? "作業時間" : "経過";
    const start = formatDateTime(facts.startTime, timeZone);
    const end = formatDateTime(facts.endTime, timeZone);
    // 同じ日なら終了は時刻だけ、日をまたぐなら月日も付ける("YYYY/MM/DD HH:MM")
    const period = start ? `${start} – ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end.slice(5)}` : "";
    return `
    <h1 ${enter(script.title.length > 18 ? "title long" : "title", 0)}>${escapeHtml(script.title)}</h1>
    <div class="facts">
      <div class="rule rule-in" style="--i:1"></div>
      <div ${enter("fact-row result", 2)} style="--i:2; --status:${status.color}">
        <div class="fact-label">結果</div>
        <div class="fact-body">
          <div class="result-line"><span class="mark">${status.mark}</span>${escapeHtml(status.label)}</div>
          <p class="lede">${escapeHtml(script.headline)}</p>
        </div>
      </div>
      <div class="rule thin rule-in" style="--i:3"></div>
      <div ${enter("figures", 4)}>
        <div class="figure"><div class="fact-label">変更ファイル</div><div class="num">${number(facts.files.length)}</div></div>
        <div class="figure"><div class="fact-label">変更行</div><div class="num">${delta("+", added, compact)}<span class="sub">${delta("−", removed, compact)}</span></div></div>
        <div class="figure"><div class="fact-label">${durationLabel}</div><div class="num">${duration.value}<small>${duration.unit}</small></div></div>
      </div>
      <div class="rule thin rule-in" style="--i:5"></div>
    </div>
    ${period ? `<div ${enter("when", 6)}>${escapeHtml(period)}</div>` : ""}`;
}
function requestScene(script, facts) {
    return `
    ${sectionHead("ご依頼の内容")}
    <blockquote ${enter("quote", 1)}>「${escapeHtml(script.request.summary)}」</blockquote>
    <div ${enter("note", 2)}>指示 ${number(facts.userPrompts)} 回 ・ ツール実行 ${number(facts.toolCalls)} 回</div>`;
}
function fileList(files, limit) {
    if (files.length === 0)
        return "";
    const shown = files.slice(0, limit);
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const rows = shown
        .map((f) => `<li class="file"><span class="path">${escapeHtml(shortenPath(f.path))}</span>` +
        `<span class="diff">${f.created ? '<span class="new">新規</span>' : ""}${delta("+", f.added)} ${delta("−", f.removed)}</span></li>`)
        .join("");
    const more = files.length > shown.length ? `<div class="more">ほか ${files.length - shown.length} ファイル</div>` : "";
    return `<div ${enter("files", 6)}>
      <div class="files-head">変更ファイル <b>${number(files.length)}</b> 件　${delta("+", added)} ${delta("−", removed)}</div>
      <ul class="mono">${rows}</ul>${more}
    </div>`;
}
function workScene(script, facts) {
    const items = script.work.items
        .map((item, i) => `<li ${enter("row", i + 1)}><span class="num-mark">${i + 1}</span><span class="row-text">${escapeHtml(item)}</span></li>`)
        .join("");
    return `
    ${sectionHead("実施した作業")}
    <ol class="rows">${items}</ol>
    ${fileList(facts.files, script.work.items.length >= 4 ? 3 : 5)}`;
}
function verificationScene(script) {
    const items = script.verification.items;
    const body = items.length
        ? `<ul class="rows">${items
            .map((item, i) => `<li ${enter(`row check ${item.result}`, i + 1)}><span class="check-mark">${CHECK[item.result].mark}</span>` +
            `<span class="row-text">${escapeHtml(item.label)}</span><span class="check-result">${CHECK[item.result].label}</span></li>`)
            .join("")}</ul>`
        : `<p ${enter("statement warn", 1)}><span class="check-mark">−</span>検証の記録はありません</p>`;
    return `${sectionHead("検証の結果")}${body}`;
}
function decisionsScene(script) {
    const items = script.decisions.items;
    if (items.length === 0) {
        return `${sectionHead("ご判断いただく事項")}
      <p ${enter("statement ok", 1)}><span class="check-mark">○</span>判断が必要な事項はありません</p>`;
    }
    const list = items
        .map((item, i) => `<li ${enter("row decision", i + 1)}><span class="num-mark">${i + 1}</span><div class="row-text">` +
        `<div class="d-title"><span class="marker">${escapeHtml(item.title)}</span></div>` +
        `<div class="d-detail">${escapeHtml(item.detail)}</div></div></li>`)
        .join("");
    return `${sectionHead("ご判断ください", true)}<ol class="rows">${list}</ol>`;
}
function closingScene(script, facts, credit, author, timeZone) {
    const items = script.next_steps.items;
    const next = items.length
        ? `${sectionHead("次のステップ")}<ul class="rows next">${items
            .map((item, i) => `<li ${enter("row", i + 1)}><span class="arrow">→</span><span class="row-text">${escapeHtml(item)}</span></li>`)
            .join("")}</ul>`
        : "";
    const models = facts.models.length > 0 ? `(${facts.models.join("、")})` : "";
    const credits = [
        // 自己報告であること(成果を良く見せる偏りがありうること)と、数値の出どころを明記する
        author === "agent"
            ? `報告: 作業をした AI エージェント${models}による自己報告。数値はセッションログから自動集計`
            : "報告: 手動で作成。数値はセッションログから自動集計",
        credit ? `音声: ${credit}` : undefined,
        `セッション ${facts.sessionId?.slice(0, 8) ?? "-"} ・ ${formatDateTime(facts.endTime, timeZone) || "-"}`,
    ]
        .filter(Boolean)
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join("");
    return `${next}
    <div ${enter("end-mark", items.length + 1)}>以上</div>
    <div ${enter("credits", items.length + 2)}>${credits}</div>`;
}
const STYLE = String.raw `
:root {
  --paper: #f5f5f1;
  --ink: #17171b;
  --ink-2: #4a4a53;
  --ink-3: #6e6e78;
  --rule: rgba(23, 23, 27, 0.18);
  --pass: #1e7a4c;
  --fail: #b42318;
  --skip: #6e6e78;
  --attention: #c2410c;
  --marker: #ffe58a;
  --serif: "Noto Serif JP Variable", serif;
  --gothic: "Zen Kaku Gothic New", sans-serif;
  --mono: "JetBrains Mono Variable", "Zen Kaku Gothic New", monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1080px; height: 1920px; overflow: hidden; background: var(--paper); }
body {
  font-family: var(--gothic);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  line-break: strict;
  word-break: auto-phrase;
  font-kerning: normal;
}
.mono { font-family: var(--mono); }
#stage { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: var(--paper); }

/* 題字(マストヘッド): 上辺の二重罫 */
header.masthead { position: absolute; top: 72px; left: 80px; right: 80px; }
.mast-row { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; }
.mast-title { font-family: var(--serif); font-weight: 900; font-size: 40px; letter-spacing: 0.08em; }
.mast-meta { font-size: 26px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.double-rule { margin-top: 18px; border-top: 4px solid var(--ink); padding-top: 5px; }
.double-rule::after { content: ""; display: block; border-top: 1.5px solid var(--ink); }

main { position: absolute; top: 230px; left: 80px; right: 80px; height: 1180px; }
/* 本文ページは天揃え(見出しの位置をそろえる)。表紙だけ中央に置く */
.scene { position: absolute; inset: 0; display: none; flex-direction: column; justify-content: flex-start; padding-top: 40px; }
.scene[data-kind="opening"] { justify-content: center; padding-top: 0; }
.scene.active { display: flex; }
/* --u は文字や余白の単位。内容があふれるシーンでは小さくする */
.content { --u: calc(var(--s, 1) * 1px); display: flex; flex-direction: column; gap: calc(40 * var(--u)); }

.enter { animation: rise 0.38s cubic-bezier(0.2, 0, 0, 1) both; animation-delay: calc(var(--i, 0) * 0.07s + 0.06s); }
@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.rule { height: 0; border-top: 2px solid var(--ink); }
.rule.thin { border-top: 1px solid var(--rule); }
.rule-in { transform-origin: left center; animation: draw 0.45s cubic-bezier(0.2, 0, 0, 1) both; animation-delay: calc(var(--i, 0) * 0.07s); }
@keyframes draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }

/* 表紙 */
.title {
  font-family: var(--serif); font-weight: 900; font-size: calc(104 * var(--u)); line-height: 1.22;
  letter-spacing: -0.005em; font-feature-settings: "palt"; text-wrap: balance;
}
.title.long { font-size: calc(84 * var(--u)); }
.facts { display: flex; flex-direction: column; gap: calc(26 * var(--u)); }
.fact-row { display: grid; grid-template-columns: calc(150 * var(--u)) 1fr; gap: calc(24 * var(--u)); align-items: start; }
.fact-label { font-size: calc(26 * var(--u)); font-weight: 700; color: var(--ink-3); letter-spacing: 0.04em; padding-top: calc(10 * var(--u)); }
.result-line {
  display: flex; align-items: baseline; gap: calc(16 * var(--u));
  font-size: calc(58 * var(--u)); font-weight: 900; color: var(--status); line-height: 1.2;
}
.result-line .mark { font-family: var(--serif); font-weight: 700; }
.lede { margin-top: calc(14 * var(--u)); font-size: calc(40 * var(--u)); font-weight: 500; line-height: 1.6; color: var(--ink-2); text-wrap: balance; }
.figures { display: grid; grid-template-columns: 1fr 1.3fr 1fr; }
.figure { padding: 0 calc(22 * var(--u)); border-left: 1px solid var(--rule); }
.figure:first-child { padding-left: 0; border-left: none; }
.figure .num {
  margin-top: calc(6 * var(--u)); font-family: var(--serif); font-weight: 800; font-size: calc(76 * var(--u));
  line-height: 1.1; font-variant-numeric: tabular-nums lining-nums; white-space: nowrap;
}
.figure .num small { font-family: var(--gothic); font-size: calc(30 * var(--u)); font-weight: 700; margin-left: calc(6 * var(--u)); color: var(--ink-2); }
.figure .num .sub { display: block; font-size: calc(34 * var(--u)); font-weight: 700; margin-top: calc(2 * var(--u)); }
.when { font-size: calc(26 * var(--u)); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.plus { color: var(--pass); }
.minus { color: var(--fail); }
.plus.zero, .minus.zero { color: var(--ink-3); }

/* 欄見出し */
.section { display: flex; flex-direction: column; gap: calc(18 * var(--u)); }
.section-title { font-size: calc(42 * var(--u)); font-weight: 900; letter-spacing: 0.04em; }
.section.attention .rule { border-top-color: var(--attention); border-top-width: 4px; }
.section.attention .section-title { color: var(--attention); }

/* 依頼 */
.quote {
  font-family: var(--serif); font-weight: 700; font-size: calc(60 * var(--u)); line-height: 1.6;
  text-indent: -0.5em; padding-left: 0.5em; text-wrap: pretty; font-feature-settings: "palt";
}
.note { font-size: calc(28 * var(--u)); color: var(--ink-3); }

/* 罫線で区切った行 */
.rows { list-style: none; display: flex; flex-direction: column; }
.row {
  display: grid; grid-template-columns: calc(64 * var(--u)) 1fr auto; column-gap: calc(18 * var(--u)); align-items: baseline;
  padding: calc(24 * var(--u)) 0; border-bottom: 1px solid var(--rule);
}
.row:first-child { padding-top: calc(4 * var(--u)); }
.row-text { font-size: calc(46 * var(--u)); font-weight: 700; line-height: 1.45; text-wrap: balance; }
.num-mark { font-family: var(--serif); font-weight: 800; font-size: calc(48 * var(--u)); color: var(--ink-3); font-variant-numeric: lining-nums; }
.check-mark { font-family: var(--serif); font-weight: 800; font-size: calc(52 * var(--u)); line-height: 1; }
.check-result { font-size: calc(32 * var(--u)); font-weight: 700; white-space: nowrap; }
.check.pass .check-mark, .check.pass .check-result { color: var(--pass); }
.check.fail .check-mark, .check.fail .check-result { color: var(--fail); }
.check.not_run .check-mark, .check.not_run .check-result { color: var(--skip); }
.statement { display: flex; align-items: baseline; gap: calc(22 * var(--u)); font-size: calc(50 * var(--u)); font-weight: 900; line-height: 1.4; }
.statement.ok { color: var(--pass); }
.statement.warn { color: var(--ink-2); }

/* 変更ファイル */
.files { padding-top: calc(6 * var(--u)); }
.files-head { font-size: calc(30 * var(--u)); font-weight: 700; color: var(--ink-2); margin-bottom: calc(10 * var(--u)); }
.files-head b { color: var(--ink); font-size: calc(36 * var(--u)); }
.files ul { list-style: none; }
.file { display: flex; justify-content: space-between; gap: calc(24 * var(--u)); font-size: calc(28 * var(--u)); line-height: 1.8; border-bottom: 1px dotted var(--rule); }
.file .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file .diff { flex: none; font-variant-numeric: tabular-nums; }
.file .new { font-family: var(--gothic); font-size: calc(22 * var(--u)); font-weight: 700; color: var(--ink-2); border: 1px solid var(--ink-3); padding: 0 calc(8 * var(--u)); margin-right: calc(14 * var(--u)); vertical-align: 2px; }
.files .more { font-size: calc(26 * var(--u)); color: var(--ink-3); margin-top: calc(8 * var(--u)); }

/* 判断事項: 見出しに蛍光ペンの下線 */
.decision .row-text { font-weight: 400; }
.d-title { font-size: calc(48 * var(--u)); font-weight: 900; line-height: 1.45; text-wrap: balance; }
.d-title .marker { background: linear-gradient(transparent 62%, var(--marker) 62%); }
.d-detail { margin-top: calc(10 * var(--u)); font-size: calc(34 * var(--u)); font-weight: 500; line-height: 1.6; color: var(--ink-2); text-wrap: pretty; }

/* 結び */
.next .row { grid-template-columns: calc(56 * var(--u)) 1fr; }
.arrow { font-family: var(--serif); font-weight: 700; font-size: calc(44 * var(--u)); color: var(--ink-3); }
.end-mark { align-self: flex-end; font-family: var(--serif); font-weight: 800; font-size: calc(64 * var(--u)); letter-spacing: 0.2em; }
.credits { font-size: calc(26 * var(--u)); line-height: 1.8; color: var(--ink-3); border-top: 1px solid var(--rule); padding-top: calc(18 * var(--u)); }

/* 字幕: 墨ベタに白抜き */
.caption-zone { position: absolute; left: 60px; right: 60px; top: 1450px; height: 300px; display: flex; align-items: center; justify-content: center; }
/* 幅は文の長さによらず一定。均等改行(balance)は文節の途中で切れやすいので使わない */
#caption {
  width: 100%; padding: 24px 40px; background: var(--ink); color: var(--paper);
  font-size: 46px; font-weight: 700; line-height: 1.5; text-align: center; text-wrap: pretty; opacity: 0;
}

/* 柱(フッター) */
footer.folio {
  position: absolute; left: 80px; right: 80px; bottom: 60px; padding-top: 14px; border-top: 1px solid var(--rule);
  display: flex; justify-content: space-between; align-items: baseline; gap: 24px; font-size: 24px; color: var(--ink-3);
}
.where { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { display: flex; gap: 22px; flex: none; }
.page { font-variant-numeric: tabular-nums; color: var(--ink-2); font-weight: 700; }
`;
/** ページ内で動くスクリプト。__seek(t) で時刻 t の状態を描き、同じ見た目かどうかの判定キーを返す。 */
const PAGE_SCRIPT = String.raw `
(() => {
  const data = JSON.parse(document.getElementById("timeline-data").textContent);
  const scenes = [...document.querySelectorAll(".scene")];
  const page = document.getElementById("page");
  const caption = document.getElementById("caption");
  const main = document.querySelector("main");
  let current = -1;

  const activate = (index) => {
    scenes.forEach((el, i) => el.classList.toggle("active", i === index));
    page.textContent = (index + 1) + " / " + scenes.length;
    current = index;
  };

  window.__prepare = async () => {
    const text = document.body.textContent + data.scenes.flatMap((s) => s.cues.map((c) => c.text)).join("");
    await Promise.all([
      ...[500, 700, 800, 900].map((w) => document.fonts.load(w + ' 48px "Noto Serif JP Variable"', text)),
      ...[400, 500, 700, 900].map((w) => document.fonts.load(w + ' 48px "Zen Kaku Gothic New"', text)),
      document.fonts.load('400 28px "JetBrains Mono Variable"', text),
    ]);
    await document.fonts.ready;
    const fitted = [];
    scenes.forEach((scene, i) => {
      activate(i);
      const content = scene.querySelector(".content");
      let scale = 1;
      while (content.offsetHeight > main.clientHeight && scale > 0.6) {
        scale = Math.round((scale - 0.04) * 100) / 100;
        content.style.setProperty("--s", String(scale));
      }
      fitted.push(scale);
    });
    activate(0);
    return fitted;
  };

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const CAPTION_LEAD = 0.1;

  window.__seek = (t) => {
    let index = data.scenes.findIndex((s) => t < s.end);
    if (index < 0) index = data.scenes.length - 1;
    if (index !== current) activate(index);
    const scene = data.scenes[index];
    const local = t - scene.start;
    const fade = Math.round(clamp01(Math.min(local / 0.2, (scene.end - t) / 0.18)) * 100) / 100;
    const el = scenes[index];
    el.style.opacity = String(fade);

    const progress = [];
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = local * 1000;
      const p = animation.effect.getComputedTiming().progress;
      progress.push(p === null ? -1 : Math.round(p * 1000));
    }

    let cueIndex = -1;
    scene.cues.forEach((cue, i) => { if (cue.start - CAPTION_LEAD <= t) cueIndex = i; });
    let captionOpacity = 0;
    if (cueIndex >= 0) {
      const cue = scene.cues[cueIndex];
      const key = index + "-" + cueIndex;
      if (caption.dataset.key !== key) {
        caption.textContent = cue.text;
        caption.dataset.key = key;
      }
      captionOpacity = Math.round(clamp01((t - cue.start + CAPTION_LEAD) / 0.12) * fade * 100) / 100;
    }
    caption.style.opacity = String(captionOpacity);
    return [index, fade, progress.join(","), cueIndex, captionOpacity].join("|");
  };
})();
`;
/** 動画 1 本分のページを作る。フォントは /fonts/ 以下から読み込む前提。 */
export function buildHtml(input) {
    const { script, facts, scenes, credit, author, timeZone } = input;
    const bodies = {
        opening: openingScene(script, facts, timeZone),
        request: requestScene(script, facts),
        work: workScene(script, facts),
        verification: verificationScene(script),
        decisions: decisionsScene(script),
        closing: closingScene(script, facts, credit, author, timeZone),
    };
    const sections = scenes
        .map((scene) => `<section class="scene" data-kind="${scene.kind}"><div class="content">${bodies[scene.kind]}</div></section>`)
        .join("\n");
    const where = [facts.project, facts.branch].filter(Boolean).join(" ・ ");
    const date = formatDateTime(facts.endTime, timeZone).slice(0, 10).replaceAll("/", ".");
    const labels = [author === "agent" ? "AI 作成" : undefined, credit].filter(Boolean).map((l) => `<span>${escapeHtml(l)}</span>`);
    const data = JSON.stringify({ scenes: scenes.map(({ kind, start, end, cues }) => ({ kind, start, end, cues })) }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/fonts/serif/index.css">
<link rel="stylesheet" href="/fonts/gothic/400.css">
<link rel="stylesheet" href="/fonts/gothic/500.css">
<link rel="stylesheet" href="/fonts/gothic/700.css">
<link rel="stylesheet" href="/fonts/gothic/900.css">
<link rel="stylesheet" href="/fonts/mono/index.css">
<style>${STYLE}</style>
</head>
<body>
<div id="stage">
  <header class="masthead">
    <div class="mast-row">
      <div class="mast-title">作業報告</div>
      <div class="mast-meta">${escapeHtml(date)}</div>
    </div>
    <div class="double-rule"></div>
  </header>
  <main>
${sections}
  </main>
  <div class="caption-zone"><div id="caption"></div></div>
  <footer class="folio">
    <span class="where">${escapeHtml(where)}</span>
    <span class="right">${labels.join("")}<span class="page" id="page"></span></span>
  </footer>
</div>
<script id="timeline-data" type="application/json">${data}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}
