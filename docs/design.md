# 動画のデザイン方針

動画は「紙の作業報告書」を縦長にしたものとして組みます。目的は、AI が作った UI に見えやすい要素を避け、短時間で読める紙面にすることです。

## 避けるもの(いわゆる「AI っぽい UI」の兆候)

AI が生成した UI は、学習データで多数派の無難な選択(Inter 系のフォント、紫のグラデーション、控えめなアニメーションなど)に寄りやすいと説明されています([Anthropic: Improving frontend design through Skills](https://claude.com/blog/improving-frontend-design-through-skills))。具体的な兆候としてよく挙げられ、初版のデザインに当てはまっていたものは次のとおりです。

| 兆候 | 初版での該当箇所 | 出典 |
|------|------------------|------|
| 暗い背景に光彩(グロー)やぼかした円形の光 | 背景の放射グラデーション | [1][2] |
| 装飾目的の格子(グリッド)背景 | 背景の 72px 格子 | [2] |
| 紫〜インディゴ系の配色 | アクセント色 `#8ea2ff` | [1][2][3] |
| 光る状態ドット | ヘッダーの丸い点 | [1][2] |
| 見出しの上の小さなラベル・バッジ | 「AGENTIC CODING REPORT」、状態のピル型バッジ | [2] |
| 小さな番号付きの小見出し | 「01 ご依頼の内容」など | [2] |
| 同じ形のカードの羅列・大きな角丸 | 各項目のカード | [1][2] |
| カードの片側だけの色帯 | 依頼文の左の色帯 | [1][2] |
| 字間を大きく広げた英字 | 英字ラベル | [4] |

- [1] [Jeff Humble: 7 Tells that a UI is AI-Generated](https://pages.thefountaininstitute.com/posts/7-tells-that-a-ui-is-ai-generated)
- [2] [Impeccable: The visible tells of AI design](https://impeccable.style/slop)
- [3] [Why Your AI Keeps Building the Same Purple Gradient Website](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)
- [4] [Noqta: AI design slop — overused UI patterns](https://noqta.tn/en/blog/ai-design-slop-overused-ui-patterns-fix-2026)

「AI っぽさ」は主観を含む評価で、上の兆候も一般的な傾向にすぎません。新しい要素を足すときは、この表に当てはまらないかを確認してください。

## UI UX Pro Max の使い方

`.claude/skills/ui-ux-pro-max/`(npm `ui-ux-pro-max-cli` 2.15.0、MIT)を導入しています。検索の例:

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "editorial report typographic print newspaper calm professional" \
  --design-system --variance 7 --motion 3 --density 2 -p "Dopagakix"
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "editorial magazine grid print typography poster" --domain style
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "japanese mincho serif display" --domain google-fonts
```

注意: このスキルは AI 製品に「AI Purple(#6366F1)」系の配色を推奨するデータを持っています。「AI」「developer tool」などの語で検索すると、避けたい配色に誘導されます。

| スキルの提案 | 扱い |
|--------------|------|
| スタイル「Editorial Grid / Magazine」「Minimalism & Swiss Style」 | 採用(罫線、非対称、印刷物風の書体、余白) |
| 控えめな動き(300〜400ms、移動量 12px 前後、ease-out) | 採用 |
| コントラスト 4.5:1 以上 | 採用(全文字色で確認済み) |
| 配色(Tailwind の slate / sky) | 不採用。Tailwind の既定色そのもので、汎用的な見た目になるため |
| 書体 Libre Bodoni / Public Sans | 不採用。欧文専用のため、日本語の明朝・ゴシックで置き換え |
| ホバー・フォーカス・レスポンシブの確認項目 | 対象外(操作のない動画のため) |

## デザイントークン

| 用途 | 値 |
|------|----|
| 紙 | `#f5f5f1` |
| 墨(本文) | `#17171b`(紙に対し 16.4:1) |
| 補助テキスト | `#4a4a53`(8.0:1)、`#6e6e78`(4.6:1) |
| 罫線 | 墨の 18% |
| 成功・完了 | `#1e7a4c`(4.9:1) |
| 失敗・未達成 | `#b42318`(6.0:1) |
| 一部完了 | `#9a6200`(4.7:1) |
| 判断待ち・要判断 | `#c2410c`(4.7:1) |
| 蛍光ペン | `#ffe58a`(上の墨文字は 14.3:1) |

書体:

- 見出し・数字: Noto Serif JP(明朝)
- 本文・字幕: Zen Kaku Gothic New(ゴシック)
- パス: JetBrains Mono

いずれも SIL Open Font License 1.1 です。

## 構成の決まりごと

- 上辺に二重罫と題字「作業報告」、下辺に柱(プロジェクト名、クレジット、ページ番号)を置く。
- 本文ページは天揃えにし、欄見出しは「罫線＋見出し」で示す。番号付きのラベルやカードは使わない。
- 項目は罫線で区切った行で並べる。検証結果は ○ / × / −、状態は ○ / △ / ! / × で表す。
- 判断を求める事項は朱色の罫と見出しで示し、題目に蛍光ペンの下線を引く。
- 最後のページは右寄せの「以上」で締める。
- 字幕は墨ベタに白抜きの帯とし、幅は一定にする。均等改行(`text-wrap: balance`)は文節の途中で切れやすいため使わない。
- 動きは「下から 14px・0.38 秒のフェードイン」と「罫線を左から引く」の 2 種類だけにする。光彩、パルス、弾むイージングは使わない。
