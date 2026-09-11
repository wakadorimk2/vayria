# GPT-Live staging integration

公開Web版のstagingで音声方式を切り替える。初期選択は既存方式とする。
GPT-Liveを選ぶと、マイクの音声会話へ確定済みカード配置を反映する。
ローカル版と展示登録端末では選択肢を表示しない。productionのLive APIは404を返す。

## 接続と状態

- モデル: `gpt-live-1`。声: `marin`。保存設定: `store: false`。委譲方式: `client`。
- ブラウザはWebRTCを使う。Workerは認証済みの公開セッションからOpenAIセッションを作る。
- `/api/live/start`、`/api/live/context`、`/api/live/stop`はpreview認証、visitor Cookie、同一Originを要求する。
- 開始と更新には有効な公開セッションを要求する。終了は公開セッションの期限後も、同じvisitorと接続要求IDに限って受け付ける。
- 既存の`PublicUsage`がsideband WebSocketを持つ。Durable Object bindingは追加しない。
- 開始前に既存STT、TTS、音声相づち、自律発話を停止する。文字入力を無効にする。
- 方式変更時に会話履歴を消去する。カード配置を保持する。
- 出力音声のRMSから口パクと発話状態を更新する。字幕は入力と出力を分離する。字幕の到着を再生完了とは扱わない。
- 字幕とカード文面はメモリだけで扱う。アプリの永続ログへ保存しない。

## カード

完全な配置、強調カードID、更新番号を送る。ドラッグ中は送らない。
サーバーは既存`cardPool`のIDと説明を使う。古い更新と重複更新を捨てる。
開始準備中の変更は、接続後に最新状態へ追いつかせる。
`session.thinking.append`の内容をUTF-8で500バイト以内に分割する。これはbyte-BPEの500トークン上限に対する保守的な制限である。
発話の強制中断は指示しない。委譲要求にも既存LLMや外部ツールを使わない。
`session.thinking.appended`の確認番号は、全分割のackが揃った時点で更新する。
ackは注入の確認である。自然な会話への反映は実際の音声で別に判定する。

## 利用上限と終了

環境別設定は`deploy/live-usage-limits.json`に置く。
管理APIの適用ツールは`scripts/apply-live-usage-limits.mjs`である。
新規の記録ファイルへ変更前設定を書いてから、指定5項目だけをconfigureする。
使用済み金額、回数、進行中セッション、他の制限をリセットする操作は送らない。
2026-09-11の適用前後の記録は、このディレクトリの`gpt-live-limits-*-2026-09-11.json`に置く。

Live開始前に残り接続時間と15秒の終了待ち分を予約する。接続時間の上限は600秒と公開セッションの期限の短い方とする。
費用は1分0.05米ドルと管理設定のUSD/JPYから整数micro-yenへ換算する。
初期15秒と累積秒数を加算しない。最終費用は`max(15, session.closed.usage.seconds)`から算出する。
累積途中報告では精算しない。終了を確認できない場合は予約額を保持する。
同じ公開セッションに同時に1本だけ許可する。既存の生成処理とも同時実行を拒否する。

ブラウザは15秒間隔で状態を送る。45秒間届かない場合、サーバーは終了する。
停止、方式変更、画面非表示、公開セッション終了でマイクと再生を止める。
サーバーのタイマーとDurable Object alarmが終了を監視する。
制御接続の喪失時は、保存したprovider IDから終了専用のsidebandを最大3回接続する。ブラウザ音声を再接続しない。
終了確認が失敗した記録は`unconfirmed`とする。追加の生成を同じ公開セッションで始めない。
管理reportの`liveSessions`に秒数、費用、理由、失敗コード、確認済みカード番号を返す。終了済みの記録は24時間以内かつ履歴2,000件以内とする。

## 検証

2026-09-11のローカル検証:

| 検証 | 結果 |
|---|---|
| `test:public` | 122件成功。Liveの認証、競合、課金、カード、終了、管理設定を含む |
| `test:voice` | 49件成功 |
| `test:performer` | 273件成功 |
| `test:playback` | 40件成功 |
| `test:cd` | 20件成功 |
| 型検査、lint、stagingビルド | 成功。Viteの既存chunkサイズ警告あり |

自動テストは偽の音声デバイスとproviderイベントを使う。
PCとiPhone/iPadの実マイク権限、音声再生、口パク、割り込み、相づち、カード変更への自然な反応、画面非表示後の実接続終了は未確認である。
声質と会話の間も未判定である。

## 配信と戻し方

未マージのDraft PRを`staging-preview`で配信する。productionへのコード配信とマージは行わない。
設定で「既存方式」へ戻す。確認できない接続が残る場合は「会話を終了」してから新しい会話を始める。
配信のコミット、Worker Version、認証、実URLの照合は配信後の記録で追記する。

## 公式仕様

- [Liveセッション](https://developers.openai.com/api/docs/guides/live-conversations)
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Sideband](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
- [状態注入と委譲](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client)
- [時間課金](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live)
