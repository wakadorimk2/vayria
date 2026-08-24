# Local STT benchmark

このフォルダーは、展示機での固定音声評価に使います。

生音声はGitへ追加しません。
音声と評価結果は`tools/stt/benchmarks/local/`へ置きます。
このパスは`.gitignore`へ登録済みです。

## 固定セット

`manifest.example.json`をコピーして、ローカルのWAVファイル名を設定します。
セットには次のケースを含めます。

- 通常の日本語発話
- 短い相槌
- 短い割り込み
- `Vayria`、`GPT-Live`、`Codex`
- 無音
- 環境音または雑音

WAVはモノラル、16-bit、16 kHz PCMにします。

## オフライン評価

展示ノートで、主プロファイルを必須にして実行します。

```powershell
Push-Location tools/stt
New-Item -ItemType Directory -Force benchmarks/local | Out-Null
Copy-Item benchmarks/manifest.example.json benchmarks/local/manifest.json
uv run --no-cache python benchmarks/run_benchmark.py `
  --manifest benchmarks/local/manifest.json `
  --audio-root benchmarks/local/audio `
  --device cuda `
  --compute-type float16 `
  --require-primary-profile
Pop-Location
```

`small / int8_float16`は次で比較します。

```powershell
uv run --no-cache python benchmarks/run_benchmark.py `
  --manifest benchmarks/local/manifest.json `
  --audio-root benchmarks/local/audio `
  --device cuda `
  --compute-type int8_float16 `
  --require-primary-profile
```

`base / float16`は同じ手順で`--model base`を指定します。
`--beam-size 1`で`beam_size=1`を比較できます。
既定値は`beam_size=3`、`temperature=(0.0, 0.2)`、hotwords有効です。
hotwordsを無効にする比較では`--hotwords ""`を指定します。

## Voice Labの遅延評価

Audio LabからJSONLをエクスポートします。
次の値をJSONLから集計します。

- `speech_ended`から`utterance_finalized`までの`endpointToResultLatencyMs`
- `sttQueuedAt`から`sttStartedAt`までの`sttQueueWaitMs`
- `sttStartedAt`から`sttObservedAt`までの`sttProcessingMs`
- `utterance_finalized`から会話入力までの`finalizedToConversationInputMs`

JSONLを追加すると、ベンチマーク結果へp50とp95を保存します。

```powershell
uv run --no-cache python benchmarks/run_benchmark.py `
  --manifest benchmarks/local/manifest.json `
  --audio-root benchmarks/local/audio `
  --voice-lab-jsonl benchmarks/local/vl-small-float16-600ms.jsonl `
  --output benchmarks/local/vl-small-float16-600ms.json
```

`--voice-lab-jsonl`を400 msと600 ms、各モデル・compute typeで分けます。
比較対象は次です。

- `small / float16`
- `small / int8_float16`
- `base / float16`

`medium`以上は初回評価へ含めません。

## 選定基準

候補は次の順で判定します。

1. CPU fallbackを使わない。
2. 30分の連続運転でサービスエラーを出さない。
3. 5分区間ごとのEOUから結果までのp95が700 ms以下。
4. 短発話の完全一致率とhallucination rateを基準より悪化させない。
5. 条件を満たす候補から固有名詞recallとCERを優先する。
6. 同点ならp95が低い候補を選ぶ。

30分試験中は`nvidia-smi`でVRAM、温度、GPU使用率を記録します。
評価結果に未達成項目を残します。
