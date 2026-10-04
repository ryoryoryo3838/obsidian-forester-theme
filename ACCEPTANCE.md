# Hybrid Markdown：追加修正の受入結果

**ソース・自動テスト・独立レビューの受入は合格。ネイティブ Obsidian 実機での受入は未実施。**

## 検証済み

- 標準 `npm test`：hybrid **495/495**、legacy **57/57**。
- `npm run build`：TypeScript 型検査＋プラグイン production bundle 成功。
- `npm run test:browser`：実 Chromium＋CodeMirror の11検証項目成功。
- 公開CLI strict 型検査成功、`npm audit --omit=dev`：0 vulnerabilities。
- 公開境界・最終UI・参照元の権限検査：独立レビューすべて合格。
- 追加の独立参照元probe **39/39**。関連82件と旧57件も成功。39件は標準495件への単純加算をしない。
- 最終 main.ts SHA-256：`34df125cab0e3fe5faa3ad5ac84701efae7bbd5f5bf49dcda0aa1c973aaf18b6`。レビューと実行の前後で一致。

## 修正した事項

1. 単独CRを含む入力は公開抽出全体を安全側で拒否。LF/CRLFは対照試験で維持。非公開・無効ノートも検査し、原文を自動正規化しない。
2. 旧機能の書込みは保存原文と全matching未保存editorで所有権を判定。非アクティブのopt-inも保護し、未保存opt-outで保存済みopt-inを無効化しない。
3. 旧subtreeコマンドは実ディスク読取りとview/editor/file/source/cursor snapshotで検査。非同期待機中のノート切替・再bind・追加入力・cursor移動を拒否し、I/Oエラーは登録callbackで通知。
4. 別ノートへの旧ID付与でも参照元の権限を再検査。処理途中でhybrid化したbufferや保存原文の変更は古い要求を停止させる。既に完了した通常ターゲットへの書込みを全体原子性と偽らない。
5. 先行レビューでの字句境界・タイトル由来・共有resolver・文献metadata出所、rollback、embedの出現別flagsとlifecycle、Source mode切替、native embedクリックの隔離も回帰試験を維持。

## 証跡（ローカル生成物・Git追跡対象外）

以下の詳細JSONは検証作業で生成したローカル証跡です。公開ブランチには回帰テストのソースとこの受入要約を保存し、生成ログやscratchの個別実行データは含めません。

- `plugin/test/build/subtree-and-origin-parent-verification.json`
- `plugin/test/build/authorized-public-review.json`
- `plugin/test/build/final-subtree-ui-review.json`
- `plugin/test/build/final-origin-signoff.json`
- `plugin/test/build/final-origin-approved-probes-readable.json`

実行承認timeoutで保留になったprobeは、ユーザーの明示承認後に元の独立scriptを実行し、証跡の追加独立レビューで受入ギャップを解消した。過去の不合格JSONは履歴として残し、上記の最終判定で置き換える。

## 限界・未実施

- Native Obsidian Desktop/Mobileとopaque Canvas内部は未検証。実ブラウザー＋CodeMirrorおよびnative境界mockの結果を実機導入と混同しない。
- 複数ファイルの原子的filesystem transactionや、最後のsample後の外部変更までは保証しない。実際の保存競合・部分rollbackは通知する。
- 公開CLIは検査済みJSON抽出。既存Foresterサイトrenderer/CIへの接続・公開・assetコピーは別工程。
- 生Foresterは保持・ハイライト、未評価。引用は簡易著者年形式で、完全APA/CSLではない。
- コードは `v2` 開発ブランチとして管理する。本番plugin導入、live vaultの変更、公開サイトdeployment、正式Releaseは対象外。

次の受入段階は**独立したダミーvaultでNative Obsidianの操作確認**。通常の研究vaultへの上書きから始めない。
