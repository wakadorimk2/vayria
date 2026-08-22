# ARDY 統合の用語

この表は、ARDY 統合で使う新しい用語の指示対象を固定します。

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 候補語 | 初出定義 |
|---|---|---|---|---|---|---|
| 統合設計 2 | 保存済み生成物と runtime 生成物を同じ再生入口へ渡す | asset ID、VRMA URL、長さ、loop、補正 profile ID、SHA-256 | 再生可能 asset の識別情報を保持する | Catalog または Provider が作成し、MotionPlayer が消費する | MotionAssetDescriptor | 再生可能な VRMA と、その provenance を表す値です。 |
| 統合設計 2、3 | 保存済み asset を正本 manifest から解決する | `public/avatar/motions/manifest.json` の asset 一覧 | 閉じた asset ID を検証し、URL へ変換する | manifest を読み、MotionAssetDescriptor を返す | SavedMotionCatalog | 保存済み motion の manifest を読む解決器です。 |
| 統合設計 2、4 | ブラウザーで VRMA の body track を再生する | `AnimationMixer`、VRMAnimationLoaderPlugin、VRM scene | body clip の開始、更新、停止、復元を担当する | MotionAssetDescriptor を受け、VrmStage が毎 frame 更新する | MotionPlayer | VRMA を VRM scene へ適用する再生器です。 |
| 統合設計 4 | ARDY の姿勢を Vayria の体格へ合わせる | retarget 後の humanoid 回転・移動へ適用する調整値 | 外部 pipeline の調整値を固定する | VRM humanoid retarget の後、VRMA encode の前に適用する | MotionCorrectionProfile | Vayria が所有する補正値の profile です。 |
| 統合設計 2、6 | 未登録 motion の runtime 生成を隠蔽する | `generate(request, signal)` を持つ provider | ARDY の詳細を Vayria 本体から隔離する | Motion Resolver が選び、MotionAssetDescriptor を返す | MotionProvider | runtime motion を生成する最小 interface です。 |
| 統合設計 2、8 | runtime provider へ安全な入力を渡す | request ID、plan ID、短い prompt、duration、seed、profile ID、source policy | 生成条件と stale 判定用 ID を運ぶ | MotionProvider が受け、ARDY raw data へ変換しない | MotionRequest | motion 生成の入力契約です。 |
| 統合設計 8 | 自由文から危険なファイル指定を作らない | manifest に登録した lowercase kebab-case の asset ID | 保存済み motion の参照キーを制限する | PerformancePlan が任意値を持ち、Catalog が検証する | assetId | manifest に登録された motion の閉じた識別子です。 |

`CardMotion` はカード UI の状態です。身体 motion の assetId には使いません。
