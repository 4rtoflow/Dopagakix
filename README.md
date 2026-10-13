# Dopagakix

AI エージェント(Claude Code)が自分の行った作業を、作業を指示した人(指示者)に **縦型動画**(1080×1920、mp4)で報告するための、Claude Code のスキルと CLI です。

指示者がスマートフォンで短時間に次の 3 点を把握できることを目的にしています。

1. 依頼した作業は終わったのか(結論)
2. 何をして、どう確かめたのか
3. 自分が判断・対応すべきことは何か

Claude Code に「動画で報告して」と頼むと、エージェントが同梱のスキル(`video-report`)の手順に従って台本を書き、`dopagakix` コマンドで動画にして渡します。

## 仕組み

```
指示者「動画で報告して」
 └─ エージェント(Claude Code)が video-report スキルを使う
     1. dopagakix prepare … 画面に出す数値をセッションログから集計し、口調・長さの目安と環境を表示
     2. 台本 report.json を書く … 文章の部分だけ。そのセッションで自分がした作業をもとに書く
     3. dopagakix check   … 形式・口調・長さ・読み上げにくい表記・数値との食い違いを確認
     4. dopagakix render  … VOICEVOX で読み上げ → HTML/CSS → Chromium で 1 コマずつ撮影 → ffmpeg → summary.mp4
 └─ mp4 を指示者に渡す
```

設計上の方針:

- **作業ログを外部の API に送りません。** 台本は作業をしたエージェント自身が、そのセッションの中で書きます。`dopagakix` が通信するのは、読み上げ文を送る VOICEVOX エンジン(通常は手元で動かすもの)だけです。
- **画面に出す数値はログから機械的に集計**し、エージェントの自己申告に頼りません。
- 台本はエージェントの **自己報告** なので、成果を良く見せる偏りが入りえます。スキルには「確かめていない検証は未実施と書く」などの規則を入れ、`check` で機械的に分かる食い違い(完了なのに検証が失敗、など)を警告します。動画にも「AI エージェントによる自己報告」と表示します。
- アニメーションはページ側で時刻を指定して止めた状態を撮影するため、マシンの速さに関係なく同じ映像になります。

## 動画の構成

| # | シーン | 内容 |
|---|--------|------|
| 1 | 結論 | 状態(完了 / 一部完了 / 判断待ち / 未達成)、タイトル、変更ファイル数・変更行数・作業時間(推定。15 分を超える空白は除外) |
| 2 | ご依頼の内容 | 指示内容の要約 |
| 3 | 実施した作業 | 作業の要点(最大 5 件)と変更ファイルの一覧 |
| 4 | 検証の結果 | テスト・ビルド等の成否。実行していなければ「未実施」 |
| 5 | ご判断ください | 指示者に判断・承認してほしいこと。なければ「判断が必要な事項はありません」 |
| 6 | 次のステップ | 次の一手、クレジット |

各シーンに VOICEVOX の読み上げと字幕が付きます。見た目は「紙の作業報告書」を縦長にしたもので、いわゆる「AI が作った UI」に見えやすい要素(暗い背景の光彩、格子背景、紫系の色、カードの羅列など)を避けています。方針と根拠は [docs/design.md](docs/design.md) にまとめています。

## 必要なもの

| もの | 用途 | 備考 |
|------|------|------|
| Claude Code | スキルを使って台本を書く | |
| Node.js 22 以上 | `dopagakix` の実行 | |
| ffmpeg | mp4 への書き出し | libx264 と aac が使えるもの |
| Chromium | 描画 | `npx playwright-core install --only-shell chromium` で導入できます |
| VOICEVOX ENGINE | 読み上げ音声 | なくても動きます(字幕のみの動画になります) |

## 導入

### 1. CLI(マシンに 1 回)

```bash
npm install -g github:4rtoflow/Dopagakix
npx playwright-core install --only-shell chromium   # Chromium が無ければ
```

ビルド済みのファイル(`dist/`)をリポジトリに含めているため、導入時にビルドは行いません(理由は「開発」を参照)。

VOICEVOX ENGINE は公式の Docker イメージで起動できます。

```bash
docker run -d --name voicevox -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
```

### 2. スキル(プロジェクトごと、または個人用に 1 回)

```bash
cd <使うプロジェクト>
dopagakix install-skill          # <プロジェクト>/.claude/skills/video-report に入れる(コミットすればチームで共有できる)
dopagakix install-skill --user   # ~/.claude/skills/video-report に入れる(自分のすべてのプロジェクトで使える)
```

手でコピーしても同じです: `cp -r "$(npm root -g)/dopagakix/.claude/skills/video-report" .claude/skills/`

Claude Code はスキルのディレクトリを監視しており、追加したスキルは実行中のセッションにも反映されます。ただし、セッション開始時に `.claude/skills` 自体が無かった場合は `/reload-skills` が必要です([Claude Code: Skills](https://code.claude.com/docs/en/skills))。`install-skill` はその場合に案内を表示します。

### 更新

```bash
npm install -g github:4rtoflow/Dopagakix
dopagakix install-skill --force   # スキルも更新する(手で編集していた場合は上書きされます)
```

`install-skill` は、既存のスキルと内容が異なる場合は `--force` なしでは上書きしません。

## 使い方

Claude Code で作業を終えたら、「動画で報告して」「動画にまとめて」などと頼みます。スキルは **頼まれたときだけ** 使うように書いてあり、作業の最後に自動では作りません(スキルの説明文で指示しているため、確実ではありません)。`/video-report` で直接呼び出すこともできます。

エージェントは、動画のパス(ファイルを送るツールがある環境ではファイルそのもの)を返します。出力は `dopagakix-out/<日時>-<セッション ID 先頭 8 桁>/` にまとまります。`dopagakix-out/` には `*` だけを書いた `.gitignore` を置くため、中身は git の管理対象になりません。

| ファイル | 内容 |
|----------|------|
| `report.json` | エージェントが書いた台本 |
| `script.json` | 描画に使った台本と数値の記録。`dopagakix render <この script.json>` で同じ内容のまま作り直せます(話者を変える、など) |
| `narration.wav` | 読み上げ音声 |
| `timeline.json` | シーンと字幕の時刻 |
| `summary.mp4` | 完成した動画 |

VOICEVOX に接続できない場合は、作業を止めずに字幕のみで作り、その旨を表示します。あとでエンジンを起動して `script.json` を `render` すれば、読み上げ付きに作り直せます。

### 設定

環境変数で変えられます。Claude Code では、`.claude/settings.json` などの `env` に書くと、そのプロジェクトのセッションに設定できます([Claude Code: Settings](https://code.claude.com/docs/en/settings-reference#env))。

| 環境変数 | 既定値 | 内容 |
|----------|--------|------|
| `DOPAGAKIX_SPEAKER` | `3` | VOICEVOX の話者(スタイル)ID。`dopagakix speakers` で一覧(3 = ずんだもん ノーマル) |
| `DOPAGAKIX_PERSONA` | `auto` | 読み上げ文の口調。`auto`(話者から判断)/ `none`(丁寧語)/ `zundamon` / 口調設定の JSON ファイル |
| `VOICEVOX_URL` | `http://127.0.0.1:50021` | VOICEVOX エンジンの URL |
| `TZ` | 実行環境の設定 | 画面の日時表示のタイムゾーン(例: `Asia/Tokyo`) |
| `DOPAGAKIX_CHROMIUM` | 自動探索 | 描画に使う Chromium の実行ファイル |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg の実行ファイル |

```json
{
  "env": {
    "DOPAGAKIX_SPEAKER": "13",
    "TZ": "Asia/Tokyo"
  }
}
```

### キャラクターの口調

読み上げに使う話者に合わせて、台本の口調を選びます(`auto`)。現在、組み込みの口調はずんだもん(一人称「ボク」、文末「〜のだ/〜なのだ」)だけです。

- `prepare` が口調の説明と例文を表示し、エージェントはそれに従って読み上げ文を書きます。`check` と `render` は、口調どおりの文末になっていない文を警告します。
- 口調が変わるのは読み上げ文と字幕だけです。画面の見出しや項目は中立な書き方のままです。
- ほかのキャラクターの口調は JSON ファイルで追加できます(`DOPAGAKIX_PERSONA=./metan.json`)。

```json
{
  "id": "metan",
  "name": "四国めたん",
  "speakerNames": ["四国めたん"],
  "style": "ここに口調の説明を書く(一人称、文末、話し方)",
  "examples": ["例文 1", "例文 2"],
  "endingPattern": "文末を確かめる正規表現(省略可)"
}
```

ずんだもんの口調は、公式プロフィール([zunko.jp](https://zunko.jp/))に記載がないため、二次情報([pixiv 百科事典](https://dic.pixiv.net/a/ずんだもん))に基づいています。キャラクターとしての利用には別途ガイドラインがあります。[東北ずん子・ずんだもんプロジェクトの利用ガイドライン](https://zunko.jp/guideline.html)では、クリエイターの非商用利用は申請不要ですが、東北企業以外の商用利用には別途ライセンス契約が必要とされています。業務で使う場合は、該当するかを確認してください。

## コマンド

| コマンド | 内容 |
|----------|------|
| `dopagakix prepare` | 出力先を作り、台本を書くための情報(画面に出る数値、口調、文字数の目安、環境、次に実行するコマンド)を表示する |
| `dopagakix check <report.json>` | 台本を確かめる。描画はしない |
| `dopagakix render <report.json>` | 動画を作る。完成した mp4 のパスだけを標準出力に出す(進捗は標準エラー) |
| `dopagakix digest` | セッションログを時系列のダイジェストにする(エージェントが作業を振り返る用。既定で 3 万文字以内) |
| `dopagakix sessions` | プロジェクトのセッションログを新しい順に表示する |
| `dopagakix speakers` | VOICEVOX の話者とスタイル ID を表示する |
| `dopagakix install-skill` | スキルを導入する |

セッションログは、`--transcript <ファイル>` → `--session <ID の先頭>` → 実行中の Claude Code のセッション(Claude Code が Bash ツールのコマンドに渡す環境変数 `CLAUDE_CODE_SESSION_ID`。[Claude Code: Environment variables](https://code.claude.com/docs/en/env-vars))→ プロジェクトの最新のログ、の順に選びます。サブディレクトリで実行しても、git のルートまでさかのぼって探します。

主なオプション(`prepare` / `check` / `render`):

| オプション | 既定値 | 説明 |
|------------|--------|------|
| `--seconds <n>` | `60` | 動画の長さの目安。読み上げ文の文字数の目安に使い、`render` では 1.25 倍を超えると話速を最大 1.45 まで上げて収めます |
| `--no-voice` | (音声あり) | 字幕のみで作ります |
| `--speaker <id>` / `--persona <name>` / `--voicevox-url <url>` | 上の表 | 環境変数より優先されます |
| `--speed <x>` | `1.25` | 話速(`render` のみ。ずんだもんの実測で約 7.3 文字/秒) |
| `--timezone <tz>` | 実行環境の設定 | 画面の日時表示に使います |
| `--out-dir <dir>` | `dopagakix-out` | 出力先の親ディレクトリ(`prepare` のみ) |
| `-o, --out <file>` | 台本と同じ場所の `summary.mp4` | 動画の出力先(`render` のみ) |

`prepare` に付けたオプションは、`prepare` が表示する `check` / `render` のコマンドにも引き継がれます。

### スキルを使わずに試す

```bash
dopagakix render "$(npm root -g)/dopagakix/examples/script.example.json" --no-voice -o dopagakix-sample/summary.mp4
```

## 所要時間の目安

開発環境(4 vCPU)での実測で、約 40 秒の動画に、音声合成 約 16〜18 秒、描画 約 41 秒かかりました。描画は動画 1 秒あたりおよそ 1 秒です。VOICEVOX は同時に複数の要求を送っても速くならなかったため、1 文ずつ順に合成しています。

## 注意事項

- **ログ形式**: Claude Code のセッションログの形式は内部仕様で、バージョンごとに変わり、直接解析するスクリプトはどの更新でも動かなくなりうると公式に明記されています([Claude Code: Manage sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored))。Claude Code 2.1.29x のログで動作を確認しています。
- **数値の範囲**: 変更ファイルと行数は、Edit / Write ツールでの変更だけを数えます。シェルのコマンド(`sed`、`git rm`、`npm install` など)で変更・削除したファイルは含みません。また、数値は常にセッション全体の集計です。
- **自己報告**: 台本はエージェントが自分の作業について書いたものです。重要な判断の前には、差分やテスト結果を確認してください。
- **権限**: スキルは `allowed-tools: Bash(dopagakix *)` を指定しており、スキルを使うターンの間は `dopagakix` コマンドを許可の確認なしで実行します([Claude Code: Skills](https://code.claude.com/docs/en/skills))。
- **VOICEVOX のクレジット**: VOICEVOX の利用規約では、VOICEVOX を利用したことがわかるクレジット表記が必要で、音声ライブラリ(キャラクター)ごとの規約にも従う必要があります([VOICEVOX 利用規約](https://voicevox.hiroshiba.jp/term/))。本ツールは「VOICEVOX:キャラクター名」を動画内に自動で表示します。使うキャラクターの規約は各自で確認してください。
- **フォント**: Noto Serif JP(見出し)、Zen Kaku Gothic New(本文・字幕)、JetBrains Mono(パス)を npm パッケージ経由で使っています(いずれも SIL Open Font License 1.1)。

## 開発

```bash
git clone https://github.com/4rtoflow/Dopagakix.git
cd Dopagakix
npm install
npm run compile      # src/ を dist/ にビルドする
npm test             # テスト(Chromium・ffmpeg・VOICEVOX があれば結合テストも実行)
npm run typecheck    # 型検査
npm link             # 開発中の版を dopagakix コマンドとして使う
```

**`src/` を変更したら、`npm run compile` を実行して `dist/` もコミットしてください。** `npm install -g github:…` で導入できるよう、ビルド済みの `dist/` をリポジトリに含めています。ビルドを `prepare` スクリプトで行う方式は、npm がグローバル導入の際に依存関係をパッケージ内に入れずにビルドしようとして失敗したため、採用していません(npm 10.9.4 と 11.21.0 で確認)。同じ理由で、npm が git から入れるときに準備処理の対象とするスクリプト名(`build`・`prepare`・`prepack` など)は使わず、ビルドは `compile` という名前にしています。`dist/` がソースと一致しているかは `npm test` で確かめます。

このリポジトリ自体にも `.claude/skills/video-report/` があるため、ここで Claude Code を使えばスキルを試せます。

```
src/
├── cli.ts                 コマンドの定義
├── pipeline.ts            ログの読み込み・台本の読み込み・描画のつなぎ込み
├── brief.ts               prepare の表示内容と環境の確認
├── skill.ts               スキルの導入
├── facts.ts               ログから集計する事実情報の型
├── persona.ts             キャラクターの口調
├── redact.ts              秘匿情報のマスク
├── transcript/            セッションログの探索・解析・ダイジェスト化
├── script/                台本のスキーマ・整形・確認(check)
├── tts/                   VOICEVOX・無音合成・WAV 処理
└── video/                 タイムライン・HTML テンプレート・描画
dist/                      ビルド済みの CLI(npm run compile で更新し、コミットする)
.claude/skills/video-report/  エージェント用のスキル(npm パッケージにも同梱)
.claude/skills/ui-ux-pro-max/ UI/UX Pro Max スキル(npm ui-ux-pro-max-cli 2.15.0、MIT。デザインの検討用)
test/                      vitest のテストと合成フィクスチャ
examples/                  スキルを使わずに render を試すためのサンプル
docs/design.md             動画のデザイン方針(避ける要素、トークン、構成の決まりごと)
```

見た目を変えるときは、先に [docs/design.md](docs/design.md) を確認してください。

## ライセンス

まだ設定していません。
