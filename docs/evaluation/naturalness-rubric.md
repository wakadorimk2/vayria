# Naturalness rubric

このrubricは、VayriaのAITuberとしての立ち居振る舞いをOwner Playcheckで確認するための基準です。

## 採点

各評価軸を次の値で採点します。

| 値 | 意味 |
| ---: | --- |
| `0` | 破綻。動作が止まる、または明確に不整合がある |
| `1` | 不自然。違和感が継続する |
| `2` | 許容。小さな違和感はあるが成立する |
| `3` | 自然。意図した演技として説得力がある |
| `N/A` | 観測不能。採点ファイルの`naReasons`へ理由を書く |

`N/A`は平均から除外します。理由のない`N/A`は無効です。

## 評価軸

| ID | 評価軸 | 観察する内容 |
| --- | --- | --- |
| `presence` | 存在感・待機状態 | 無入力中の呼吸、瞬き、揺れ、過剰反応 |
| `timing` | 間・ターン交替 | 発話前の間、返答開始、沈黙、割り込み後の復帰 |
| `continuity` | 内容の連続性・変化 | 話題継続、話題変更、直前表現の反復回避 |
| `emotion` | 感情と発話の整合 | 文面、声、表情、感情強度の一致 |
| `embodiment` | 声・視線・動きの統一 | 視線、表情、口パク、idle motion、TTSの一致 |

## 合否

- 数値`0`が1つでもあれば`fail`です。
- `timing`、`emotion`、`embodiment`の数値採点がすべて`2`以上である必要があります。
- 全数値採点の平均が`2.0`以上である必要があります。
- 必須ケースをすべて記録し、各ケースに少なくとも1つの数値採点を入れます。
- 重大軸が一度も観測できない場合は`incomplete`です。

## ケース

| ID | 前提 | 操作 | 主な観察点 |
| --- | --- | --- | --- |
| `idle_presence` | アバターと音声を準備する | 無入力で20秒以上待つ | `presence`, `embodiment` |
| `manual_response` | セッションをリセットする | 短い入力を1回送る | `timing`, `emotion`, `embodiment` |
| `autonomous_turn` | 自律発話を有効にする | 次の自律候補を待つ | `timing`, `continuity`, `emotion` |
| `silence_gap` | 自律発話を継続する | 沈黙または非発話反応を待つ | `presence`, `timing`, `embodiment` |
| `continuity_variation` | 自律発話を複数回待つ | 話題継続と話題変更を観察する | `continuity`, `emotion` |
| `interruption` | 自律処理を開始する | thinkingまたはspeaking中に手動入力する | `timing`, `continuity`, `embodiment` |

観察した分岐が発生しない場合は`N/A`を使います。`notes`には発話本文や秘密情報を書きません。
