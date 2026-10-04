# Obsidian Forester — Theme & Plugin

Markdownを正本にしたまま、Foresterのtree/subtree・参照・transclusionをObsidianで扱うテーマ＋プラグインです。

> **`v2` はhybrid実装の開発ブランチ、`2.0`（タグ`2.0.0`）はPre-releaseです。正式な安定版ではありません。** 新しいhybrid modeはopt-inです。既存のlegacy modeを残し、通常ノートを一括変換しません。自動テストと独立レビューは合格していますが、Native Obsidian Desktop/Mobileの実機受入は未実施です。

## v2でできること

- H2〜H6をsubtreeとして扱い、root/subtree共通のID索引で参照を解決。
- Live PreviewとReading viewでtaxon・文脈番号・embed・引用を表示。編集対象の構文はソースへ戻す。
- 必要時に固定IDを付与し、`[[Note#Heading]]`を`[[Note#^ID]]`へ安全側で確定。曖昧な参照や競合は変更しない。
- `![[Note#^ID]] %%ht%%`で、そのembedの見出し全体とTOC項目を非表示。
- `{ref:[[Reference note]]}`を文献metadataによる簡易著者年表示に変換。
- `\{ ... }`内の生Foresterを保持・ハイライト。**評価・import実行はしない。**
- 非公開を既定にした公開JSON抽出。非公開本文は配信データへ入れず、危険・曖昧な依存は公開拒否。

詳しいcontractは [HYBRID.md](HYBRID.md)、検証結果は [ACCEPTANCE.md](ACCEPTANCE.md)。旧サイト/tree-md互換モードの説明は [LEGACY.md](LEGACY.md) に分離しています。

## ビルドと導入

Node.jsとnpmが必要です。まず**研究vaultとは別のダミーvault**で試してください。

```sh
git clone --branch v2 https://github.com/ryoryoryo3838/obsidian-forester-theme.git
cd obsidian-forester-theme/plugin
npm ci --ignore-scripts
npm test
npm run build
```

生成された以下の3ファイルを、テストvaultの `.obsidian/plugins/forester/` に置きます。

```text
plugin/main.js
plugin/manifest.json
plugin/styles.css
```

Community pluginsでForesterを有効化します。plugin IDは既存版と同じ `forester` なので、既存版を使っているvaultへ最初から上書きしないでください。テーマの導入は任意です。

テーマも含めてコピーする既存helperもあります。**指定先のForesterファイルを置き換えるので、テストvaultだけに使います。**

```sh
cd ..
./scripts/install.sh --copy /absolute/path/to/test-vault
```

生成bundleはGitに含めません。配布は [2.0 Pre-release](https://github.com/ryoryoryo3838/obsidian-forester-theme/releases/tag/2.0.0) の `manifest.json`・`main.js`・`styles.css` を使えます。既存の安定版はLatestのまま残します。BRATの既存設定が安定版を取得する場合は、2.0.0を明示して取得するか、Releaseのファイルを手動で入れてください。`v2`ブランチのpushだけではReleaseやサイトdeploymentは行いません。

## 最小のノート

```markdown
---
forester-mode: true
forester-id: ABCDEF
title: Information concepts
publish: false
---

# Information concepts

## Definition ^B4C2D1
#Claim

本文。通常の参照 [[Reference note]] と引用 {ref:[[Reference note]]}。

![[Other note#^C1D2E3]] %%ht%%
```

- `forester-mode: true`でそのノートを有効化。設定の **Hybrid folders** でフォルダをopt-inすることもできます。
- `forester-mode: false`は有効フォルダ内でもopt-out。
- root IDはfrontmatterの `forester-id`、subtree IDは見出し末尾の `^ID`。旧 `id`を黙って再解釈しません。
- 自動IDは大文字6桁16進、数字だけ6桁は手動用に予約。手動IDは英数字・ハイフンで、長さ/16進制約なし。
- taxonは見出し直後の専用タグ行、またはmetadataで指定。通常のタグやファイル名とIDを混同しません。
- `examples/hybrid-demo/`には架空資料だけのサンプルを置いています。

## ノート中心のmetadata

`authors`と`dates`は標準Properties UIで**リスト型**にし、`[[miya]]`や`[[2026-10-04]]`を入力します。保存時のYAML引用符はObsidianに管理させ、手入力しません。日付ノートへのリンクはDate型の値とは別です。

現版はこのwikilink文字列の保持と親子継承に対応しています。ただし、**人物/日付ノートから表示名・日付値を取得する層は未実装**です。hybridの帰属metadataは複数形 `authors` / `dates`。単数形 `author` / `date`は通常の未知frontmatterとして保持されます。

文献用はノート著者とは別です：

```yaml
citation-authors: [Bates]
publication-year: 2022
```

`citation-authors`は現時点では表示用文字列を使います。wikilinkから著者名を解決する機能、完全APA/CSL、引用ページ・同年文献の区別は今後の範囲です。

## 非公開と部分公開

公開は既定でfalse。設定の **Public folders** は構文のopt-inとは独立です。意図して公開する資料だけを配置してください。

```markdown
## 公開する部分 ^D0C0DE
%% publish: true %%

非公開ノート内でも、このsubtreeだけを公開できます。

## タイトルのみ公開 ^F00BAA
%% publish: false, public-title: true %%

この本文は公開しません。
```

**private source自体はprivate repositoryに置く必要があります。** `publish: false`は公開GitHubへpushしたMarkdownを秘匿できません。著作権・公開可否を自動判定する機能でもありません。

```sh
cd plugin
npm run build:public
node dist/project-public.mjs \
  --vault /absolute/path/to/private-vault \
  --out /absolute/path/outside-vault/public-forest.json
```

CLIはソースを書き換えず、hidden directoryとsymlinkを辿りません。出力はvault外のJSONのみ。失敗時はnonzeroで公開を拒否し、以前の成功artifactが残る場合があるため、必ず終了コードを確認します。LF/CRLFは対応し、単独CRは安全側で拒否します。未検証asset・生HTML・公開領域のraw評価等も拒否します。

これは**検査済みJSON抽出まで**で、Forester HTML rendererや既存CIへの接続・deploymentは別工程です。

## 開発・検証

```sh
cd plugin
npm test              # hybrid 495件 + legacy 57 checks
npm run build         # TypeScript + production bundle
npm run test:browser  # 実Chromium + CodeMirror
npm audit --omit=dev
```

ブラウザーテストはPlaywright cacheのChromium headless shell、または `HYBRID_CHROMIUM=/absolute/path/to/chromium` が必要です。テスト実行中にブラウザーや依存packageを自動installしません。

公開境界・保存/表示・参照元権限の独立レビューも合格。詳細は [ACCEPTANCE.md](ACCEPTANCE.md)。保存処理はsnapshot/CAS/rollbackを使いますが、複数ファイルの原子的filesystem transactionやあらゆる外部同期競合までは保証しません。

## 構成

```text
plugin/src/hybrid-*.ts        parser/index/resolver/public/view/save/controller
plugin/scripts/project-public.ts  公開JSON抽出CLI
plugin/test/                 legacy + hybrid + 実CM/browser回帰
examples/hybrid-demo/        ダミーノート
HYBRID.md                    記法・安全境界の詳細
ACCEPTANCE.md                実測検証結果と制限
LEGACY.md                    旧モードの説明
manifest.json, theme.css     任意のForesterテーマ
scripts/install.sh          既存のテーマ/プラグイン導入helper
```

Datalog、全文検索統合、全Forester評価、トランスパイラ適合、本番pipeline移行、metadata関係解決は現版の完了範囲に含めません。
