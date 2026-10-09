# Structured public forest: bounded acceptance

## 配布対象と公開境界

- 公開CLIに`--format forest`を追加。`forester-public-v2`はroot／named／anonymous subtree、literal title、metadata、typed transclusionとh/t flagsを保持する。既定のpublic-v1は互換用として維持する。
- private-by-defaultを維持する。非公開Markdown内の明示公開subtreeは独立したpublic islandであり、非公開の祖先・兄弟・子・filename fallback・私的な継承metadataを出力しない。リンク到達可能性は公開許可ではない。title-onlyも本文公開と独立した許可である。
- `%%p%%`はprivateの省略形のまま。新しい公開短縮記法、IDの変更、ノートの自動移行を追加しない。
- v2のblock transclusionは先頭0–3 spaces、単一embed、任意の同一行h/t controlを受理する。canonical h/t/htを保持し、未知のcompact flag、複数control、同じ物理行の前置コメントやembed–flag間コメントは明示拒否する。独立行の先行コメント、canonical flag後のordinary comment、protected literalの例示は対照検証した。
- CLIはsourceを変更しない。失敗時のgeneric診断／nonzeroと、検証失敗による出力parent未作成を確認した。以前の成功artifactが残る場合があるため、終了コードを必ず確認する。

## Producer検証

- 変更した7source/test filesと実CLIを独立レビューでSHA-256固定。最終レビュー前後の84source files、既存artifact、入力bytes/mtimeは不変だった。
- scanner断片によるinline embed／setextの誤受理、comment-adjacent flagsの黙殺を別々の再現と限定TDD修正で解消した。元の4flag回帰、以前の8guard回帰、専用139testsが成功した。
- 独立した実root CLI matrixはLF/CRLF込み68/68、public-v1差分は74/74、private境界matrixは36/36成功。これらを重複のない単一総件数として足し合わせない。
- 全suiteはhybrid849／workspace24／styles51と保持したlegacy checksが成功。TypeScript／production build、公開CLI build、実Chromiumの既存browser checksを実行した。native Obsidianの受入とは区別する。
- 現sourceのfresh bundleと実CLIがbyte一致。CLI SHA-256: `84e21e7a06a07667a04ed195dd9ae6fc7387337007bfac5a8a1e46e9b605d3de`。

## 別repoの下流受入

対応converterは新しい`Tree_of_md` façade／`tree_of_md` CLIで構造付きJSONを受け取り、旧`Tree_md`／`tree-md`利用者を維持する。consumerのstrict schema、未知／duplicate keys、ID・dangling参照・合成cycle・literal escapingの独立レビューは合格した。

合成public forestをconverterから固定Forester source revision `f8fb5f5d88923db36643cf9c20c662adff969c98`（表示`6.0~dev`）へ渡し、named8routes、anonymous section、metadata継承、h/t flags、非公開route404を実HTML/XMLとChromiumで検証した。DOI／ORCID hrefの二重prefixは実native出力で修正を確認した。timestampの時刻・timezoneを黙って失わないよう、public consumerはcalendar date以外を`PF_DATE`で拒否する。これはsynthetic identifierのregistry登録を確認する検証ではない。

公開snapshot／SSG呼出側は別repo・別レビューである。consumerのOS I/O失敗では部分stagingが残るため、呼出側は失敗した出力全体を破棄する。単独converterをatomic snapshot transactionと扱わない。

## 未完了／未保証

- 実ノートの公開審査・入力repoへの投入、専用content認証、実CI有効化、Cloudflare本番deployはこのplugin Releaseの受入に含めない。
- `miya-lis-public`はprivateのまま。既存vault backupを公開入力へ流用せず、raw vault／非公開本文・filename・assetsを公開用Actionsに渡さない。
- inline transclusion、未審査assets、raw／HTMLや一部TeX表現は未対応でfail-closed。全Forester言語や正式stable 6.0との適合を主張しない。
- 全入力の網羅的fuzzing、同時symlink差替えのTOCTOU、複数fileのatomic transaction、native Obsidian／Mobile／reloadの総合受入、持続freezeの原因確定は未保証。
- 本番vaultのplugin／設定／ノートや本番サイトはこの配布更新で変更しない。同じ2.0.0のPre-release差替えなので、利用する場合は公開CLIとplugin3filesを再取得する。UI/themeのsourceは変更せず、pluginも公開CLIと同commitから再buildする。companion theme ZIPは既存の検証済みbytesを維持する。
