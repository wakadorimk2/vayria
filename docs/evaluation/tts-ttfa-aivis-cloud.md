# Aivis Cloud TTS TTFA evaluation

Date: 2026-09-02

## Decision

Aivis Cloudをprimary TTS providerとして採用する。
Local AivisSpeechは非常用fallback providerとして維持する。

Issue #78はOpenのまま維持する。
展示用ノートPCと本番予定networkでfailure recoveryを確認した後に、完了を判定する。

## Measured results

iPad SafariでLocalとCloudを計測した。
各backendは、短文、通常文、長文を10回ずつ計測した。
各backendの計測件数は30件である。
warm-upは集計から除外した。
通常の計測では失敗を検出しなかった。

| Fixture | Backend | TTFA p50 / p95 | First audio p50 / p95 | Total synthesis p50 / p95 |
| --- | --- | ---: | ---: | ---: |
| Short | Local | 468 / 571 ms | 466 / 570 ms | 466 / 570 ms |
| Short | Cloud | 321 / 424 ms | 293 / 395 ms | 324 / 424 ms |
| Normal | Local | 1420 / 2067 ms | 1416 / 2061 ms | 1416 / 2061 ms |
| Normal | Cloud | 431 / 919 ms | 403 / 890 ms | 435 / 926 ms |
| Long | Local | 4802 / 4952 ms | 4792 / 4942 ms | 4792 / 4942 ms |
| Long | Cloud | 554 / 675 ms | 525 / 646 ms | 632 / 1158 ms |

CloudはLocalに対してTTFA p50を31%から88%短縮した。
短文は31%、通常文は70%、長文は88%短縮した。
iPad SafariでCloudのstreaming再生を確認した。

## iPad Safari playback diagnostics

iPad Safariで3種類のCloud MP3再生経路を比較した。
各経路は、短文、通常文、長文を3回ずつ計測した。

`media-source`は9件すべてで音声を再生した。
有効RMSは0件だった。
これは、MediaSource音源がAnalyserNodeへ音声sampleを渡さない現象と一致する。

`media-element-blob`は9件すべてで有効RMSを検出した。
再生開始から有効RMSまでの中央値は430 msから434 msだった。
Ownerは、発話冒頭がかすれて聞こえる場合があると評価した。

`audio-buffer`は9件すべてで有効RMSを検出した。
再生開始から有効RMSまでは49 msから64 msだった。
decode時間は6 msから33 msだった。
Ownerは、発話冒頭の欠落を検出しなかった。

この結果に基づき、音声はMediaSourceでstreaming再生する。
同じMP3からdecodeしたRMS envelopeをlip sync解析に使用する。
この方式は音声を再生し直さない。

## Owner observation

Ownerは、LocalとCloudの声質が同じに聞こえたと評価した。
これは聴感による評価である。
model同一性を技術的に証明するものではない。

## Deferred validation

次の項目は未確認である。

- 展示用ノートPCでのLocalとCloudの比較
- 本番予定networkでのLocalとCloudの比較
- 実通信切断時の自動fallbackと会話継続
- Cloud再生開始後のstream切断時に重複発話とhangが発生しないこと

raw benchmark JSON、raw playback diagnostics JSON、発話本文、model UUID、API keyはrepositoryへ保存しない。
