import type { FileChange, SessionFacts } from "../facts.js";
import { type CheckResult, STATUS_LABELS, type ScriptStatus, type VideoScript } from "../script/schema.js";
import { formatDateTime } from "../util/time.js";
import type { TimedScene } from "./timeline.js";

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

export interface TemplateInput {
  script: VideoScript;
  facts: SessionFacts;
  scenes: TimedScene[];
  credit?: string;
  timeZone?: string;
}

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  dash: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 6.5v11M15 6.5v11"/></svg>',
  half: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" class="fill"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/></svg>',
} as const;

const STATUS: Record<ScriptStatus, { label: string; color: string; icon: string }> = {
  completed: { label: STATUS_LABELS.completed, color: "#34d399", icon: ICONS.check },
  partial: { label: STATUS_LABELS.partial, color: "#fbbf24", icon: ICONS.half },
  blocked: { label: STATUS_LABELS.blocked, color: "#fb923c", icon: ICONS.pause },
  failed: { label: STATUS_LABELS.failed, color: "#f87171", icon: ICONS.cross },
};

const CHECK: Record<CheckResult, { label: string; icon: string }> = {
  pass: { label: "成功", icon: ICONS.check },
  fail: { label: "失敗", icon: ICONS.cross },
  not_run: { label: "未実施", icon: ICONS.dash },
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 長いパスは先頭側のディレクトリを省いて末尾を残す。 */
export function shortenPath(file: string, max = 36): string {
  if (file.length <= max) return file;
  const parts = file.split("/");
  while (parts.length > 1 && `…/${parts.join("/")}`.length > max) parts.shift();
  const tail = `…/${parts.join("/")}`;
  return tail.length <= max ? tail : `…${file.slice(file.length - max + 1)}`;
}

function formatElapsed(minutes: number | undefined): { value: string; unit: string } {
  if (minutes === undefined) return { value: "-", unit: "" };
  if (minutes < 60) return { value: String(minutes), unit: "分" };
  const hours = minutes / 60;
  return { value: hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1), unit: "時間" };
}

const number = (n: number) => n.toLocaleString("ja-JP");
/** 統計の大きな数は桁を丸めて枠に収める */
const compact = (n: number) =>
  n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : number(n);
/** 増減の表示。0 は色を付けない */
const delta = (sign: "+" | "−", n: number, format = number, extra = "") =>
  `<span class="${sign === "+" ? "plus" : "minus"}${n === 0 ? " zero" : ""}${extra}">${sign}${format(n)}</span>`;

/** 要素の登場順(アニメーションの遅延)を付ける */
const enter = (i: number) => `class="enter" style="--i:${i}"`;
const enterWith = (cls: string, i: number) => `class="enter ${cls}" style="--i:${i}"`;

function sectionLabel(no: number, text: string, attention = false): string {
  return `<div ${enterWith(`section-label${attention ? " attention" : ""}`, 0)}><span class="no">${String(no).padStart(2, "0")}</span>${escapeHtml(text)}</div>`;
}

function openingScene(script: VideoScript, facts: SessionFacts, timeZone?: string): string {
  const status = STATUS[script.status];
  const added = facts.files.reduce((n, f) => n + f.added, 0);
  const removed = facts.files.reduce((n, f) => n + f.removed, 0);
  const elapsed = formatElapsed(facts.elapsedMinutes);
  const period = facts.startTime
    ? `${formatDateTime(facts.startTime, timeZone)} – ${formatDateTime(facts.endTime, timeZone).slice(-5)}`
    : "";
  return `
    <div ${enter(0)}><span class="kicker">AGENTIC CODING REPORT</span></div>
    <div ${enterWith("status-pill", 1)}>${status.icon}${status.label}</div>
    <h1 ${enterWith(script.title.length > 22 ? "title long" : "title", 2)}>${escapeHtml(script.title)}</h1>
    <p ${enterWith("headline", 3)}>${escapeHtml(script.headline)}</p>
    <div ${enterWith("stats", 4)}>
      <div class="stat"><div class="num">${number(facts.files.length)}</div><div class="label">変更ファイル</div></div>
      <div class="stat"><div class="num">${delta("+", added, compact)}${delta("−", removed, compact, " small")}</div><div class="label">変更行</div></div>
      <div class="stat"><div class="num">${elapsed.value}<small>${elapsed.unit}</small></div><div class="label">経過時間</div></div>
    </div>
    ${period ? `<div ${enterWith("when mono", 5)}>${escapeHtml(period)}</div>` : ""}`;
}

function requestScene(script: VideoScript, facts: SessionFacts): string {
  return `
    ${sectionLabel(1, "ご依頼の内容")}
    <blockquote ${enterWith("quote", 1)}>${escapeHtml(script.request.summary)}</blockquote>
    <div ${enterWith("note", 2)}>指示 ${number(facts.userPrompts)} 回 · ツール実行 ${number(facts.toolCalls)} 回</div>`;
}

function fileList(files: FileChange[], limit: number): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, limit);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const rows = shown
    .map(
      (f) =>
        `<li class="file"><span class="path">${escapeHtml(shortenPath(f.path))}</span>` +
        `<span class="diff">${f.created ? '<span class="new">NEW</span>' : ""}${delta("+", f.added)} ${delta("−", f.removed)}</span></li>`,
    )
    .join("");
  const more = files.length > shown.length ? `<div class="more">ほか ${files.length - shown.length} ファイル</div>` : "";
  return `<div ${enterWith("files", 6)}>
      <div class="files-head">変更ファイル <b>${number(files.length)}</b>${delta("+", added)}${delta("−", removed)}</div>
      <ul class="mono">${rows}</ul>${more}
    </div>`;
}

function workScene(script: VideoScript, facts: SessionFacts): string {
  const items = script.work.items
    .map((item, i) => `<li ${enterWith("item", i + 1)}><span class="icon">${ICONS.check}</span><span>${escapeHtml(item)}</span></li>`)
    .join("");
  return `
    ${sectionLabel(2, "実施した作業")}
    <ul class="items">${items}</ul>
    ${fileList(facts.files, script.work.items.length >= 4 ? 3 : 5)}`;
}

function verificationScene(script: VideoScript): string {
  const items = script.verification.items;
  const body = items.length
    ? `<ul class="checks">${items
        .map(
          (item, i) =>
            `<li ${enterWith(`check ${item.result}`, i + 1)}><span class="icon">${CHECK[item.result].icon}</span>` +
            `<span class="label">${escapeHtml(item.label)}</span><span class="result">${CHECK[item.result].label}</span></li>`,
        )
        .join("")}</ul>`
    : `<div ${enterWith("empty warn", 1)}>${ICONS.dash}<span>検証の記録はありません</span></div>`;
  return `${sectionLabel(3, "検証の結果")}${body}`;
}

function decisionsScene(script: VideoScript): string {
  const items = script.decisions.items;
  if (items.length === 0) {
    return `${sectionLabel(4, "ご判断いただく事項")}
      <div ${enterWith("empty ok", 1)}>${ICONS.check}<span>判断が必要な事項はありません</span></div>`;
  }
  const list = items
    .map(
      (item, i) =>
        `<li ${enterWith("decision", i + 1)}><div class="d-title">${escapeHtml(item.title)}</div>` +
        `<div class="d-detail">${escapeHtml(item.detail)}</div></li>`,
    )
    .join("");
  return `${sectionLabel(4, "ご判断ください", true)}<ol class="decisions">${list}</ol>`;
}

function closingScene(script: VideoScript, facts: SessionFacts, credit: string | undefined, timeZone?: string): string {
  const items = script.next_steps.items;
  const next = items.length
    ? `${sectionLabel(5, "次のステップ")}<ul class="next">${items
        .map((item, i) => `<li ${enter(i + 1)}><span class="icon">${ICONS.arrow}</span><span>${escapeHtml(item)}</span></li>`)
        .join("")}</ul>`
    : "";
  const credits = [
    "要約: Claude による自動生成。正確な内容はセッションログで確認してください",
    credit ? `音声: ${credit}` : undefined,
    `セッション ${facts.sessionId?.slice(0, 8) ?? "-"} · ${formatDateTime(facts.endTime, timeZone) || "-"}`,
  ]
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line!)}</div>`)
    .join("");
  return `${next}
    <div ${enterWith("end", items.length + 1)}>
      <div class="end-title">以上です</div>
      <div class="credits">${credits}</div>
    </div>`;
}

const STYLE = String.raw`
:root {
  --bg: #0a0f1e;
  --text: #f4f6fb;
  --muted: #aab3c8;
  --faint: #6f7a96;
  --surface: rgba(255, 255, 255, 0.055);
  --border: rgba(255, 255, 255, 0.1);
  --brand: #8ea2ff;
  --pass: #34d399;
  --fail: #f87171;
  --skip: #94a3b8;
  --warn: #fbbf24;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1080px; height: 1920px; overflow: hidden; background: var(--bg); }
body {
  font-family: "Noto Sans JP Variable", sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  line-break: strict;
  word-break: auto-phrase;
}
.mono { font-family: "JetBrains Mono Variable", "Noto Sans JP Variable", monospace; }
svg { fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
svg .fill { fill: currentColor; stroke: none; }
#stage { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
.bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(900px 700px at 12% 6%, color-mix(in srgb, var(--status) 24%, transparent), transparent 70%),
    radial-gradient(800px 800px at 100% 78%, rgba(110, 130, 255, 0.17), transparent 70%),
    linear-gradient(180deg, #0c1224 0%, #0a0f1e 55%, #070b16 100%);
}
.bg::after {
  content: ""; position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 72px 72px;
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9), transparent 80%);
}

header.top { position: absolute; top: 76px; left: 72px; right: 72px; }
.top-row { display: flex; justify-content: space-between; align-items: center; font-size: 30px; color: var(--muted); }
.brand { display: flex; align-items: center; gap: 16px; font-weight: 700; color: var(--text); letter-spacing: 0.04em; }
.brand .dot { width: 18px; height: 18px; border-radius: 50%; background: var(--status); box-shadow: 0 0 24px var(--status); }
.counter { font-variant-numeric: tabular-nums; letter-spacing: 0.06em; }
.progress { display: flex; gap: 10px; margin-top: 28px; }
.seg { flex: 1; height: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.14); }
.seg.done { background: rgba(255, 255, 255, 0.5); }
.seg.current { background: var(--brand); }

main { position: absolute; top: 240px; left: 72px; right: 72px; height: 1170px; }
.scene { position: absolute; inset: 0; display: none; flex-direction: column; justify-content: center; }
.scene.active { display: flex; }
/* --u は文字や余白の単位。内容があふれるシーンでは小さくする */
.content { --u: calc(var(--s, 1) * 1px); display: flex; flex-direction: column; gap: calc(44 * var(--u)); }

.enter { animation: rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both; animation-delay: calc(var(--i, 0) * 0.12s + 0.08s); }
@keyframes rise { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }

.kicker { font-size: calc(28 * var(--u)); letter-spacing: 0.32em; color: var(--faint); font-weight: 700; }
.status-pill {
  align-self: flex-start; display: inline-flex; align-items: center; gap: calc(14 * var(--u));
  padding: calc(14 * var(--u)) calc(34 * var(--u)) calc(14 * var(--u)) calc(24 * var(--u));
  border-radius: 999px; font-size: calc(42 * var(--u)); font-weight: 800; color: var(--status);
  background: color-mix(in srgb, var(--status) 15%, transparent);
  border: 3px solid color-mix(in srgb, var(--status) 55%, transparent);
}
.status-pill svg { width: calc(48 * var(--u)); height: calc(48 * var(--u)); stroke-width: 3; }
.title {
  font-size: calc(96 * var(--u)); line-height: 1.2; font-weight: 900; letter-spacing: -0.01em;
  text-wrap: balance; font-feature-settings: "palt";
}
.title.long { font-size: calc(80 * var(--u)); }
.headline { font-size: calc(46 * var(--u)); line-height: 1.55; color: var(--muted); font-weight: 500; text-wrap: balance; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(20 * var(--u)); }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: calc(28 * var(--u)); padding: calc(28 * var(--u)) calc(26 * var(--u)) calc(24 * var(--u)); }
.stat .num { font-size: calc(64 * var(--u)); font-weight: 800; line-height: 1.05; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; white-space: nowrap; }
.stat .num small { font-size: calc(32 * var(--u)); font-weight: 700; margin-left: calc(6 * var(--u)); color: var(--muted); }
.stat .num .small { display: block; font-size: calc(34 * var(--u)); font-weight: 700; margin-top: calc(4 * var(--u)); }
.stat .label { margin-top: calc(14 * var(--u)); font-size: calc(28 * var(--u)); color: var(--muted); }
.when { font-size: calc(28 * var(--u)); color: var(--faint); }
.plus { color: var(--pass); }
.minus { color: var(--fail); }
.plus.zero, .minus.zero { color: var(--faint); }

.section-label { display: flex; align-items: center; gap: calc(22 * var(--u)); font-size: calc(44 * var(--u)); font-weight: 800; }
.section-label .no {
  font-family: "JetBrains Mono Variable", monospace; font-size: calc(30 * var(--u)); font-weight: 800;
  color: #0a0f1e; background: var(--brand); border-radius: calc(12 * var(--u)); padding: calc(6 * var(--u)) calc(14 * var(--u));
}
.section-label.attention { color: var(--warn); }
.section-label.attention .no { background: var(--warn); }

.quote {
  position: relative; font-size: calc(60 * var(--u)); line-height: 1.5; font-weight: 700;
  padding: calc(56 * var(--u)) calc(56 * var(--u)) calc(56 * var(--u)) calc(66 * var(--u));
  background: var(--surface); border: 1px solid var(--border); border-radius: calc(36 * var(--u));
  text-wrap: balance;
}
.quote::before {
  content: ""; position: absolute; left: 0; top: calc(44 * var(--u)); bottom: calc(44 * var(--u));
  width: calc(10 * var(--u)); border-radius: 0 8px 8px 0; background: var(--brand);
}
.note { font-size: calc(30 * var(--u)); color: var(--faint); }

.items, .checks, .next, .decisions { list-style: none; display: flex; flex-direction: column; gap: calc(22 * var(--u)); }
.item {
  display: flex; gap: calc(26 * var(--u)); align-items: flex-start; font-size: calc(48 * var(--u)); line-height: 1.45; font-weight: 650;
  padding: calc(30 * var(--u)) calc(36 * var(--u)); background: var(--surface); border: 1px solid var(--border); border-radius: calc(28 * var(--u));
  text-wrap: balance;
}
.item .icon, .check .icon {
  flex: none; width: calc(60 * var(--u)); height: calc(60 * var(--u)); border-radius: 50%;
  display: grid; place-items: center;
}
.item .icon { margin-top: calc(5 * var(--u)); background: color-mix(in srgb, var(--pass) 18%, transparent); color: var(--pass); }
.item .icon svg, .check .icon svg { width: calc(36 * var(--u)); height: calc(36 * var(--u)); stroke-width: 3; }

.files { padding: calc(30 * var(--u)) calc(36 * var(--u)); border-radius: calc(28 * var(--u)); background: rgba(0, 0, 0, 0.28); border: 1px solid var(--border); }
.files-head { display: flex; align-items: baseline; gap: calc(18 * var(--u)); font-size: calc(32 * var(--u)); color: var(--muted); margin-bottom: calc(14 * var(--u)); }
.files-head b { color: var(--text); font-size: calc(40 * var(--u)); margin-right: calc(10 * var(--u)); }
.files ul { list-style: none; }
.file { display: flex; justify-content: space-between; gap: calc(24 * var(--u)); font-size: calc(30 * var(--u)); line-height: 1.75; }
.file .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d6dcef; }
.file .diff { flex: none; font-variant-numeric: tabular-nums; }
.file .new { font-size: calc(22 * var(--u)); font-weight: 800; color: #0a0f1e; background: var(--brand); border-radius: 6px; padding: 2px 8px; margin-right: calc(14 * var(--u)); vertical-align: 3px; }
.files .more { font-size: calc(28 * var(--u)); color: var(--faint); margin-top: calc(6 * var(--u)); }

.check {
  display: grid; grid-template-columns: auto 1fr auto; gap: calc(26 * var(--u)); align-items: center;
  padding: calc(30 * var(--u)) calc(34 * var(--u)); border-radius: calc(28 * var(--u)); background: var(--surface); border: 1px solid var(--border);
  font-size: calc(46 * var(--u)); font-weight: 650; line-height: 1.4; text-wrap: balance;
}
.check .result { font-size: calc(32 * var(--u)); font-weight: 800; padding: calc(8 * var(--u)) calc(22 * var(--u)); border-radius: 999px; white-space: nowrap; }
.check.pass .icon, .check.pass .result { color: var(--pass); background: color-mix(in srgb, var(--pass) 16%, transparent); }
.check.fail .icon, .check.fail .result { color: var(--fail); background: color-mix(in srgb, var(--fail) 16%, transparent); }
.check.not_run .icon, .check.not_run .result { color: var(--skip); background: color-mix(in srgb, var(--skip) 16%, transparent); }
.check.fail { border-color: color-mix(in srgb, var(--fail) 45%, transparent); }

.empty {
  display: flex; align-items: center; gap: calc(28 * var(--u)); font-size: calc(50 * var(--u)); font-weight: 750; line-height: 1.4;
  padding: calc(48 * var(--u)); border-radius: calc(32 * var(--u)); background: var(--surface); border: 1px solid var(--border);
}
.empty svg { flex: none; width: calc(72 * var(--u)); height: calc(72 * var(--u)); stroke-width: 3; }
.empty.ok { color: var(--pass); }
.empty.warn { color: var(--warn); }

.decisions { counter-reset: decision; gap: calc(26 * var(--u)); }
.decision {
  position: relative; padding: calc(36 * var(--u)) calc(40 * var(--u)) calc(36 * var(--u)) calc(124 * var(--u));
  border-radius: calc(32 * var(--u)); background: color-mix(in srgb, var(--warn) 9%, transparent);
  border: 2px solid color-mix(in srgb, var(--warn) 45%, transparent);
}
.decision::before {
  counter-increment: decision; content: counter(decision);
  position: absolute; left: calc(36 * var(--u)); top: calc(36 * var(--u));
  width: calc(62 * var(--u)); height: calc(62 * var(--u)); border-radius: 50%;
  display: grid; place-items: center; background: var(--warn); color: #1a1405; font-weight: 900; font-size: calc(36 * var(--u));
}
.d-title { font-size: calc(52 * var(--u)); font-weight: 800; line-height: 1.35; text-wrap: balance; }
.d-detail { margin-top: calc(14 * var(--u)); font-size: calc(36 * var(--u)); line-height: 1.55; color: var(--muted); text-wrap: pretty; }

.next li { display: flex; gap: calc(24 * var(--u)); align-items: flex-start; font-size: calc(46 * var(--u)); font-weight: 650; line-height: 1.45; text-wrap: balance; }
.next .icon { flex: none; color: var(--brand); width: calc(52 * var(--u)); height: calc(52 * var(--u)); margin-top: calc(8 * var(--u)); }
.next .icon svg { width: 100%; height: 100%; stroke-width: 3; }
.end { padding-top: calc(40 * var(--u)); border-top: 1px solid var(--border); }
.end-title { font-size: calc(88 * var(--u)); font-weight: 900; letter-spacing: 0.02em; }
.credits { margin-top: calc(24 * var(--u)); font-size: calc(28 * var(--u)); line-height: 1.8; color: var(--muted); }

.caption-zone { position: absolute; left: 60px; right: 60px; top: 1440px; height: 320px; display: flex; align-items: center; justify-content: center; }
#caption {
  max-width: 100%; padding: 22px 36px; border-radius: 26px;
  background: rgba(6, 10, 22, 0.8); border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 46px; font-weight: 750; line-height: 1.45; text-align: center;
  text-wrap: balance; opacity: 0;
}
footer.bottom {
  position: absolute; left: 72px; right: 72px; bottom: 64px;
  display: flex; justify-content: space-between; align-items: center; gap: 24px; font-size: 26px; color: var(--faint);
}
.where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badges { display: flex; gap: 12px; flex: none; }
.badge { padding: 6px 16px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
`;

/** ページ内で動くスクリプト。__seek(t) で時刻 t の状態を描き、同じ見た目かどうかの判定キーを返す。 */
const PAGE_SCRIPT = String.raw`
(() => {
  const data = JSON.parse(document.getElementById("timeline-data").textContent);
  const scenes = [...document.querySelectorAll(".scene")];
  const segments = [...document.querySelectorAll(".seg")];
  const counter = document.getElementById("counter");
  const caption = document.getElementById("caption");
  const main = document.querySelector("main");
  let current = -1;

  const activate = (index) => {
    scenes.forEach((el, i) => el.classList.toggle("active", i === index));
    segments.forEach((el, i) => {
      el.classList.toggle("done", i < index);
      el.classList.toggle("current", i === index);
    });
    counter.textContent = (index + 1) + " / " + scenes.length;
    current = index;
  };

  window.__prepare = async () => {
    const text = document.body.textContent + data.scenes.flatMap((s) => s.cues.map((c) => c.text)).join("");
    await Promise.all([
      ...[400, 500, 650, 700, 750, 800, 900].map((w) => document.fonts.load(w + ' 48px "Noto Sans JP Variable"', text)),
      document.fonts.load('400 30px "JetBrains Mono Variable"', text),
      document.fonts.load('800 30px "JetBrains Mono Variable"', text),
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
    const fade = Math.round(clamp01(Math.min(local / 0.25, (scene.end - t) / 0.2)) * 100) / 100;
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
      captionOpacity = Math.round(clamp01((t - cue.start + CAPTION_LEAD) / 0.15) * fade * 100) / 100;
    }
    caption.style.opacity = String(captionOpacity);
    return [index, fade, progress.join(","), cueIndex, captionOpacity].join("|");
  };
})();
`;

/** 動画 1 本分のページを作る。フォントは /fonts/ 以下から読み込む前提。 */
export function buildHtml(input: TemplateInput): string {
  const { script, facts, scenes, credit, timeZone } = input;
  const bodies = {
    opening: openingScene(script, facts, timeZone),
    request: requestScene(script, facts),
    work: workScene(script, facts),
    verification: verificationScene(script),
    decisions: decisionsScene(script),
    closing: closingScene(script, facts, credit, timeZone),
  };
  const sections = scenes
    .map((scene) => `<section class="scene" data-kind="${scene.kind}"><div class="content">${bodies[scene.kind]}</div></section>`)
    .join("\n");
  const segments = scenes.map(() => '<div class="seg"></div>').join("");
  const where = [facts.project, facts.branch].filter(Boolean).join(" · ");
  const data = JSON.stringify({ scenes: scenes.map(({ kind, start, end, cues }) => ({ kind, start, end, cues })) }).replace(
    /</g,
    "\\u003c",
  );

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/fonts/noto/index.css">
<link rel="stylesheet" href="/fonts/mono/index.css">
<style>${STYLE}</style>
</head>
<body>
<div id="stage" style="--status: ${STATUS[script.status].color}">
  <div class="bg"></div>
  <header class="top">
    <div class="top-row">
      <div class="brand"><span class="dot"></span>作業報告</div>
      <div class="counter mono" id="counter"></div>
    </div>
    <div class="progress">${segments}</div>
  </header>
  <main>
${sections}
  </main>
  <div class="caption-zone"><div id="caption"></div></div>
  <footer class="bottom">
    <span class="where mono">${escapeHtml(where)}</span>
    <span class="badges"><span class="badge">AI 要約</span>${credit ? `<span class="badge">${escapeHtml(credit)}</span>` : ""}</span>
  </footer>
</div>
<script id="timeline-data" type="application/json">${data}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}
