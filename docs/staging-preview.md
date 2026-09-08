# PRのstaging自動配信

## 導入

この基盤はmainへのマージ後に使える。導入PRのマージでは既存CDが動き、その時点のmainをstaging、productionの順に配信する。展示モードPRのマージは不要。

リポジトリに `staging-preview` ラベルを作成する。配信を始めたいPRへ、write以上の権限を持つ担当者が付ける。初回導入時のラベル作成・付与・配信は実装検証に含めない。

既存のstaging environmentに `CLOUDFLARE_API_TOKEN` と `VAYRIA_ASSETS_READ_TOKEN` が必要。production用の資格情報は使わない。environmentのブランチ制限はmain側のworkflowを許可する。承認待ちが設定されている場合は、その承認後に配信する。

## 操作

1. 対象PRへ `staging-preview` を付ける。同じリポジトリからmainへ向けた、未マージのPRが対象。
2. 最新コミットのCI、Python STT、Public checksが成功すると、自動でビルドと配信が進む。CIを重複起動しない。
3. GitHub Actionsの「Staging preview」でPR番号・コミットを確認する。配信後はWorker VersionとGitHub Deploymentの状態も確認する。
4. `https://staging.vayria.me` をiPad縦向きで開く。既存の検証用アクセス認証を通す。

新しいPRへラベルを付けると、以前のPRのラベルを外す。対象PRの更新後もCI成功を待って配信する。古いCI結果、別PRのCI結果、失敗したCIでは配信しない。

ラベルを外す、またはPRを閉じると自動更新を停止する。最後に配信した版は残る。配信中のCloudflareへの送信を強制中断しないため、送信開始後の解除ではその配信が完了する場合がある。

mainを戻す場合は、Actions → Staging preview → Run workflowでmainを指定する。検証指定を解除し、最新mainをstagingだけへ配信する。productionの配信は起動しない。

## mainの優先

main更新時は検証指定を解除する。mainのCDは実行中・待機中のpreview workflowが完了するまで待ち、その後stagingを更新する。待機は最大15分。完了しなければmainの配信を停止し、失敗として報告する。未完了のアップロードをキャンセルして追い越さない。

mainのCI/CDが完了するまでは新しい検証指定を受け付けない。mainの成功後にラベルを付け直す。mainの更新や新しい指定が入ると、古いpreviewの配信直前検査は失敗する。PR用の直列化とmainの直列化は別にし、GitHub concurrencyの待機枠でPRがmainを押し出さないようにする。

## 資格情報と成果物

選択・配信処理はmainのコードを使う。PRのビルドは別のGitHub-hosted runnerで行い、read-only権限だけを持つ。書込token、Cloudflare token、実VRM取得tokenをPRのスクリプトへ渡さない。共有キャッシュも使わない。

ビルドはダミーVRMで行う。配信ジョブが固定manifestの実VRMを取得し、サイズとSHA-256を確認して差し替える。実VRMはActions artifactに保存しない。ビルドartifactの保存期間は1日。

配信ジョブはmain由来のWrangler、固定のstaging設定、ビルド済みWorkerだけを使う。PRの設定やbuild hookを実行しない。ファイルリンク・予期しないファイル・外部ファイルを参照するWorker importを拒否する。現在の単一JS Worker bundleを対象とし、新しい外部モジュール構成は対応を検討してから許可する。

配信失敗時はActionsの選択コミットとDeploymentを確認する。Worker Versionが出た後の疎通失敗では、更新が反映されている可能性がある。自動rollbackはしない。

## 検証範囲

`npm run test:cd` は選択、CI失敗、先端変更、ラベル解除・再付与、PR終了、fork拒否、main更新、待機順序、artifact検査、production経路の維持を模擬APIで検証する。

初回配信後の疎通確認はGETのみ。展示枠作成、端末登録、有料生成は自動化しない。iPadの表示・音声・参加者交代は別途実機で確認する。実装時点ではworkflowの実配信とiPad確認は未実施。
