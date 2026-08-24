# Conversation Router v1

## 対象

Conversation Routerは、Vayria開発画面の開発用機能です。

次のURLパラメータで有効にします。

```text
http://127.0.0.1:5187/?router=1&audioLab=1
```

RouterはViteの開発ビルドでだけ有効です。

Routerは次の状態を別々に持ちます。

- `controlState`: `idle`、`human_override`、`interrupting`、`cooldown`
- `vayriaLane`: `idle`、`listening`、`speaking`
- `gptLane`: `idle`、`listening`、`speaking`
- `gptInputGate`: GPT音声からVayria入力へのゲート
- `vayriaOutputGate`: Vayria出力ゲート

Routerは自律発話理由を作りません。Routerは音声状態、ゲート状態、評価値だけを観測します。
`Take Floor`は候補を削除せず、自律処理を停止します。`Let Continue`は処理可能状態へ戻します。
理由がない状態で`Let Continue`を実行しても、LLMや発話は生成しません。

## 操作

UIボタンまたは次のホットキーを使います。

| 操作 | ホットキー | 動作 |
| --- | --- | --- |
| Stop Vayria | `Ctrl+Shift+V` | Vayriaの現在ターンと再生を停止 |
| Stop GPT lane | `Ctrl+Shift+G` | GPT音声のVayria入力を遮断 |
| Take Floor | `Ctrl+Shift+F` | 自律処理を停止してHuman Overrideへ遷移 |
| Let Continue | `Ctrl+Shift+C` | 500msのCooldown後に自律処理を再開 |
| Reset | `Ctrl+Shift+R` | VayriaとRouterを初期状態へ戻す |

`Stop GPT lane`はChatGPT Windowsアプリを停止しません。

`Stop GPT lane`はVayria側の入力ゲートだけを閉じます。

## Remote PCM入力

RouterパネルでRemote PCMの入力デバイスを選択できます。

選択値はブラウザーのローカル設定にだけ保存します。

デバイスIDはRouterイベントとJSONLに保存しません。

Remote PCMを開始している間はデバイス選択を変更できません。

## 手動オーディオ経路

仮想オーディオドライバとChatGPT Windowsアプリは手動で設定します。

今回の実装はドライバとアプリをインストールしません。

次の3系統を仮想ミキサーで分離します。

1. Vayria音声出力 → ChatGPT入力
2. ChatGPT音声出力 → Vayria Remote PCM入力
3. 物理マイク → Human操作用

最終確認では、各方向を単独で音声メーターに表示します。

## 評価ケース

既存のケースIDを再利用します。

- `voice_listener_reaction`
- `interruption`
- `continuity_variation`

`continuity_variation`は6往復を上限にします。

自律評価は固定タイマーでは開始しません。Evidenceから候補理由がある場合だけ、
共通の自律ポリシー評価を実行します。

RouterパネルでCase StartとCase Finishを操作します。

自然さの採点は自動化しません。

自然さはOwner Playcheckで別に採点します。

Routerは次の集計値を表示します。

- ターン数
- 状態遷移エラー
- 誤割り込み
- 確定割り込み
- 割り込み遅延
- backchannel反復
- ゲート遮断数
- cooldown時間

## JSONL保存

Routerイベントは`POST /api/router/events`でローカルAPIへ送信します。

保存先は次の形式です。

```text
VAYRIA_PLAYCHECK_ROOT/router/<sessionId>/events.jsonl
```

イベントには、時刻、origin、kind、状態、decision、reason、遅延、ケースID、派生メトリクスだけを保存します。

サーバーは許可フィールドを検証します。

次のフィールドは拒否します。

- `text`
- `audio`
- `prompt`
- `history`
- `command`
- `deviceId`
- APIキーと秘密情報

## 未接続の外部依存

ChatGPT Windowsアプリの応答生成はRouterから制御しません。

仮想オーディオドライバのインストールは手動作業です。

GPT音声メーターから`gpt_status`または`gpt_audio`を送るアダプターは将来追加します。
