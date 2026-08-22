# Vayria の NVIDIA ARDY 統合

## 現在実装した境界

```text
PerformancePlan.motion.assetId
  -> SavedMotionCatalog
  -> MotionAssetDescriptor
  -> MotionPlayer
  -> VrmStage の AnimationMixer
```

`assetId` は `public/avatar/motions/manifest.json` に登録した値だけを使います。

`VrmStage` は ARDY の raw skeleton、Python exception、CUDA 状態を知りません。

VRMA の body clip は hips、spine、arms、legs を所有します。

body clip の再生中は `IdleController` を停止します。

表情、瞬き、リップシンクは既存 controller が所有します。

Session Reset は MotionPlayer を停止し、取得中の motion request を無効化します。

保存済み asset の取得または再生に失敗した場合は、idle へ戻します。

## ARDY の位置

ARDY は Vayria repository の外部 process です。

将来の runtime generation は、Node 側の Motion Service へ接続します。

ブラウザーは ARDY process へ直接接続しません。

runtime の通常経路は `saved_then_ardy` です。

保存済み motion の lookup が失敗した時だけ runtime generation を許可します。

runtime が失敗した場合は、保存済み motion または idle へ fallback します。

## 補正の正本

補正の処理順序は次です。

```text
ARDY native motion
  -> ARDY native post-process
  -> canonical VRM humanoid retarget
  -> Vayria Motion Correction
  -> VRMA encode
  -> structural validation
```

補正値は `tools/motion/profiles/vayria-default-v1.json` で管理します。

保存済み asset と runtime asset は同じ `correctionProfileId` を使用します。

`VrmStage` は補正 profile を読みません。

## 未実装の境界

- ARDY process の自動起動
- Vayria Node API の `/api/motion/generate`
- runtime asset store
- WebSocket streaming
- 複雑な runtime blending
- motion の自由文 selector

これらは展示 MVP の成功条件にしません。
