# Obsidian Forester — Theme & Plugin

Markdownを正本にしたまま、Foresterのtree/subtree・参照・transclusionをObsidianで扱うテーマ＋プラグインです。

> **`v2` は開発ブランチ、`2.0`（タグ`2.0.0`）はPre-releaseです。正式な安定版ではありません。** この差替えでは全Markdownノートを既定でForesterとして扱い、除外フォルダでopt-outします。既存ノートを起動時に一括変換する機能ではありませんが、対象ノートを編集するとH2〜H6へ自動IDを付けるため、まず別vaultで検証してください。初回2.0.0の起動硬直の完全な原因確定・本番総合受入は未完了です。経緯は [STARTUP-INCIDENT.md](STARTUP-INCIDENT.md)。

## v2でできること

- H2〜H6をsubtreeとして扱い、root/subtree共通のID索引で参照を解決。
- Live PreviewとReading viewでtaxon・文脈番号・embed・引用を表示。編集対象の構文はソースへ戻す。
- 編集が落ち着いた対象ノートのH2〜H6すべてへ固定IDを付与。rootは必要時に発行し、既存IDは保持する。
- `[[Note#Heading]]`を`[[Note#^ID]]`へ安全側で確定。曖昧な参照や競合は変更しない。
- `/subtree`で節を作成、`/transclude`・`/link`でID・title・ファイル名からtreeを検索して組み込み／リンクを挿入。
- Forester TOC／Backlinks／Related／Referencesを個別のサイドバータブとして表示。
- 有効ノート間の通常リンクは保存時に `[[元のtarget|参照先title]]` へ補完。明示ラベル・embed・保護領域は変更しない。
- `![[Note#^ID]] %%ht%%`で、そのembedの見出し全体とTOC項目を非表示。
- `{ref:[[Reference note]]}`を文献metadataによる簡易著者年表示に変換。
- `\{ ... }`内の生Foresterを保持・ハイライト。**評価・import実行はしない。**
- 非公開を既定にした公開JSON抽出。非公開本文は配信データへ入れず、危険・曖昧な依存は公開拒否。

詳しいcontractは [HYBRID.md](HYBRID.md)、この差替えの検証範囲と実機の未確認事項は [ACCEPTANCE-V2-WORKSPACE.md](ACCEPTANCE-V2-WORKSPACE.md)。旧opt-in版の受入記録は [ACCEPTANCE.md](ACCEPTANCE.md)、旧サイト/tree-md規約は [LEGACY.md](LEGACY.md) に分離しています。

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

### v2対応テーマ

`v2`ブランチのルート `theme.css` と `manifest.json` が対応テーマです。BIZ UDMincho系の本文・既存の埋込みInria Sansを維持し、hybridのroot taxon、IDの点線リンク、著者・日付のmetadata行、13ptのsubtree見出し、枠のない組み込み表示を整えています。light/darkとtheme/pluginの両CSS読み込み順でChromium検証済みです。フォントが未インストールの場合の本文フォールバックは従来どおりです。

テストvaultの `.obsidian/themes/Forester/` にこの2ファイルを置き、外観設定で **Forester** を選択します。`plugin/styles.css` はプラグイン用なので、`theme.css`の代わりには使いません。対応テーマは`v2`ブランチのルート、またはReleaseの `forester-theme.zip`（テーマ用のmanifest同梱）から取得します。Release直下の `manifest.json` はプラグイン用です。

テーマも含めてコピーする既存helperもあります。**指定先のForesterファイルを置き換えるので、テストvaultだけに使います。**

```sh
cd ..
./scripts/install.sh --copy /absolute/path/to/test-vault
```

生成bundleはGitに含めません。配布は [2.0 Pre-release](https://github.com/ryoryoryo3838/obsidian-forester-theme/releases/tag/2.0.0) の `manifest.json`・`main.js`・`styles.css` を使えます。既存の安定版はLatestのまま残します。BRATの既存設定が安定版を取得する場合は、2.0.0を明示して取得するか、Releaseのファイルを手動で入れてください。`v2`ブランチのpushだけではReleaseやサイトdeploymentは行いません。

## 最小のノート

```markdown
---
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

- `forester-mode`は不要です。既存の値は保持しますが、構文有効化／無効化には使いません。
- Foresterとして扱わない範囲は設定の **Excluded folders** にvault相対のフォルダを一行ずつ指定します。子フォルダも除外します。
- 除外範囲ではプラグインによるID付与・入力支援・旧モードへのfallbackを行いません。
- root IDはfrontmatterの `forester-id`、subtree IDは見出し末尾の `^ID`。旧 `id`を黙って再解釈しません。
- 自動IDは大文字6桁16進、数字だけ6桁は手動用に予約。手動IDは英数字・ハイフンで、長さ/16進制約なし。
- taxonは見出し直後の専用タグ行、またはmetadataで指定。通常のタグやファイル名とIDを混同しません。
- `examples/hybrid-demo/`には架空資料だけのサンプルを置いています。

## サイドバーと入力支援

コマンドパレットの **Open Forester TOC / Backlinks / Related / References** で、それぞれのタブを開きます。

Reading／Live Previewの本文下部には、純正Foresterのbackmatterと同じ順序で **References → Backlinks → Related** を表示します。空の欄は出さず、各項目は折り畳みで、展開時に本文を読み込みます。`[ID]`から定義元へ移動し、Ctrl/Cmdクリックは新しいleafへ開きます。各ペインの文書／明示したtree-pageに対応し、カーソル位置には追従しません。

本文内のトグル付き「Tree目次」は撤去しました。目次は独立したTOCサイドバーを使います。標準ObsidianのBacklinksや設定は変更しないため、標準の「文書内バックリンク」を有効にしている場合は両方が表示されます。

この変更の検証範囲は [ACCEPTANCE-BACKMATTER.md](ACCEPTANCE-BACKMATTER.md) を参照してください。既存Releaseの更新とは別の`v2`ソース変更です。

- TOCの見出し：表示中のsectionへ移動。組み込み項目もその表示箇所へ移動し、定義元を開く操作とは分けます。
- TOCの **■**：アドレスを持つ定義元treeへ移動。
- Backlinks：現在treeを直接リンクしているtree。Related：現在treeが直接リンクする、Reference以外のtree。
- References：現在treeとその包含・組み込み先が参照するReference。組み込みだけではBacklinks／Relatedになりません。
- 関係項目を開くと実ファイルへ移動し、subtreeの場合はID位置へ移動します。Ctrl/Cmdクリックは新しいleafへ開きます。TOCのページ内移動やカーソル移動だけでは、関係タブの対象treeを変えません。

`/subtree`は新しいH2を作成し、`/transclude`・`/link`はtreeを検索するピッカーを開きます。コマンドパレットの **Mint address for subtree at cursor** もhybrid用ID処理へ接続します。キー割当はObsidian設定で行い、既存割当を上書きする既定hotkeyは追加しません。

## ノート中心のmetadata

`authors`と`dates`は標準Properties UIで**リスト型**にし、`[[miya]]`や`[[2026-10-04]]`を入力します。保存時のYAML引用符はObsidianに管理させ、手入力しません。日付ノートへのリンクはDate型の値とは別です。

現版はwikilink文字列の保持と親子継承に加え、tree headerの著者・日付リンクを共通索引で解決し、参照先titleまたは明示ラベルで表示します。ISO形式の日付ラベルは読みやすく整形しますが、日付ノートの任意プロパティから値を推論する機能ではありません。hybridの帰属metadataは複数形 `authors` / `dates`。単数形 `author` / `date`は通常の未知frontmatterとして保持されます。

`contributors`と認識済みnative propertiesは宣言したtreeに保持しますが、著者・日付と同じようには継承しません。`author: false`はnativeの表示抑制指定として保持される例外です。追加properties・contributors・BibTeXの完全なnative描画や、この表示抑制指定のheader反映は未実装です。

文献用はノート著者とは別です：

```yaml
citation-authors: [Bates]
publication-year: 2022
```

`citation-authors`は現時点では表示用文字列を使います。wikilinkから著者名を解決する機能、完全APA/CSL、引用ページ・同年文献の区別は今後の範囲です。

## 非公開と部分公開

公開は既定でfalse。設定の **Public folders** は表示／解析の対象とは独立です。意図して公開する資料だけを配置してください。

subtreeを非公開にする省略形は **`%%p%%`（private）**。見出し直後のmetadataとして置き、`%% publish: false %%`と同じ公開境界を作ります。

```markdown
## 非公開の節 ^ABCDEF
%%p%%

公開しない本文。
```

子subtreeも非公開を継承しますが、子に`publish: true`を明示すれば例外公開です。Obsidian内では通常どおり読めます。埋め込み表示用の`h`/`t`とは別の指定なので、`%%htp%%`や埋め込み末尾には書きません。

**この省略形には対応ビルドのplugin／公開CLIが必要です。古い配布版は`%%p%%`を無視するため、更新するまでは長い`%% publish: false %%`を使用してください。**

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

既定の出力は互換用の`forester-public-v1`です。Forester向けの構造付き出力は`--format forest`で明示します。

```sh
node dist/project-public.mjs \
  --vault /absolute/path/to/private-vault \
  --format forest \
  --out /absolute/path/outside-vault/public-forest.json
```

`forester-public-v2`ではnamed／anonymous subtree、metadata、transclusionのh/t flagsを保持します。非公開ノート内の公開subtreeは、非公開の祖先・兄弟・子・filename fallback・私的な継承metadataを伴わない独立した公開rootです。リンクされているだけでは公開許可を与えません。公開の省略記法は追加せず、`%%p%%`はprivateのままです。

v2のtransclusionは独立した行に置き、h/tは同じ行の直後へ一つだけ付けます。同じ行でembedの前やembedとflagの間にコメントを挟む配置、複数control、未知flagは黙って無視せず拒否します。未対応のinline transclusion・asset・raw／HTML等も安全側で拒否します。

対応する`tree_of_md --public-forest public-forest.json --out-dir trees`へ渡す構造です。旧`tree-md` CLI／`Tree_md`は互換用に維持します。固定Forester `6.0~dev`での実HTML/XML・Chromiumの合成受入と独立レビューの範囲は [ACCEPTANCE-PUBLIC-FOREST.md](ACCEPTANCE-PUBLIC-FOREST.md) を参照してください。正式なstable 6.0への適合保証ではありません。

これは**ローカル公開JSON抽出まで**で、実コンテンツ審査・CIの認証／有効化・Cloudflare deploymentは別工程です。既存のprivate vault backupと公開用の入力repoを分離し、公開用Actionsにはraw vaultを渡しません。

## 開発・検証

```sh
cd plugin
npm test              # parser/public/controller/input/sidebar/CSSの回帰
npm run build         # TypeScript + production bundle
npm run test:browser  # 実Chromium + CodeMirror
npm audit --omit=dev
```

ブラウザーテストはPlaywright cacheのChromium headless shell、または `HYBRID_CHROMIUM=/absolute/path/to/chromium` が必要です。テスト実行中にブラウザーや依存packageを自動installしません。

公開境界・保存/表示・参照元権限は回帰テストで検証しています。今回の検証範囲と実機の未確認事項は [ACCEPTANCE-V2-WORKSPACE.md](ACCEPTANCE-V2-WORKSPACE.md)。保存処理はsnapshot/CAS/rollbackを使いますが、複数ファイルの原子的filesystem transactionやあらゆる外部同期競合までは保証しません。

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

Datalog、全文検索統合、全Forester評価、全構文のトランスパイラ適合、本番pipeline移行、完全なmetadata関係モデルは現版の完了範囲に含めません。同じ2.0.0の差替えなので、自動更新が検出されない場合はPre-releaseの3ファイルを再取得してください。
