# 自律発話タイミング調査メモ

Status: Research memo
Scope: 調査、現行実装の対応付け、後続PoCの設計
Out of scope: production schedulerの置換、`AutonomyTimingV2`の実装、LLMプロンプト変更、Avatar制御の変更

## 0. 暫定結論

現行Vayriaは、意味的なEvidenceから候補を選び、その候補をターンゲートへ渡す構造です。
現在のrefractoryは、候補の意味を作らず、候補を実行できる時刻を制御します。

最初のPoCでは、hazardを「発話内容」や「候補」を作る層にしません。
hazardは「発話機会」を生成します。
その後、既存Autonomy Stateが候補の有無を評価します。

この境界なら、発話タイミングと意味的な候補選択を分離できます。
一方、候補がない状態では発話は起きません。
無理由の自発発話まで扱うには、候補またはEvidenceの生成方式を別途設計する必要があります。

現時点ではoscillatorの採用を決めません。
まず現行方式と単純な経過時間hazardを比較します。
周期的な発話窓を説明できない場合だけ、oscillatorを後続候補に残します。

## 1. 現行実装の基準線

### 1.1 候補選択

[`selectAutonomyCandidate`](../../src/conversation/autonomyState.ts#L995) は、次のreadinessを確認します。

- autonomy loopが有効である。
- performerがbusyでない。
- floorが利用可能である。
- attentionが利用可能である。
- interactionが利用可能である。

その後、active episodeに属するactive reasonを評価します。
未評価のEvidenceがあるreasonだけが候補になります。
候補がなければ `null` を返します。

したがって、現行の候補は「経過時間だけ」では生成されません。
Evidence、reason、readinessが必要です。

### 1.2 ターンゲート

[`useAutonomousTalk`](../../src/conversation/useAutonomousTalk.ts#L102-L103) は、既に選択されたcandidateを保持します。
タイマーはgate stateだけを変更します。
タイマーは意味的なcandidateを生成しません。

ゲートの状態は次の4つです。

```text
initial_quiet → ready → running → refractory → ready
```

初期設定は次のとおりです。

- initial autonomy delay: 4秒
- quiet time minimum: 8秒
- quiet time maximum: 18秒

設定値は[`src/performer/profile.ts`](../../src/performer/profile.ts#L13-L15)にあります。

### 1.3 ランダムrefractory

[`sampleAutonomyQuietTime`](../../src/conversation/autonomyTurnGate.ts#L151-L166) は、最小値と最大値の範囲から整数ミリ秒を一様に選びます。

発話または無発話のターンが完了すると、通常はrefractoryへ入ります。
viewer speechなどの外部イベントは、refractoryを早期に解除できます。
turn中の外部イベントは、turn完了後の再開を要求します。
Session Resetはinitial quietから再開します。

### 1.4 現行の基準フロー

```text
Evidence
  ↓
Autonomy Stateがreasonを保持
  ↓
selectAutonomyCandidate()
  ↓
candidateをuseAutonomousTalkへ渡す
  ↓
initial quiet / refractory / hard gateを確認
  ↓
Performanceを実行
```

現行実装の説明は、[`docs/architecture/performer-runtime.md`](../architecture/performer-runtime.md#autonomous-candidate)とも整合します。

## 2. 先行研究・概念の比較

### 2.1 Oscillatorによるturn-taking

[Wilson & Wilson (2005)](https://doi.org/10.3758/BF03206432) は、turn-takingの発話開始確率が、短い沈黙の中で周期的に上下するというoscillator modelを提案します。

このモデルは、発話開始の時間構造を考える材料になります。
ただし、発話内容、意味的な候補、Vayria固有のhard gateを決めるモデルではありません。

この資料から得られるVayria向けの示唆は、次のとおりです。

- 発話開始を単純な固定cooldownだけで表現しなくてもよい。
- 発話しやすさをphaseまたはreadinessとして観測できる。
- oscillatorだけで発話の意味や相手との関係を説明してはいけない。

### 2.2 発話内容と発話タイミングの分離

[Gambi & Pickering (2011)](https://doi.org/10.3389/fpsyg.2011.00275) は、会話を共同活動として扱い、相手の発話を予測しながら自分の発話を計画する枠組みを論じます。

これは、発話開始時刻と発話内容を同じ決定に押し込めない設計を支持します。
Vayriaでは、timing layerとAutonomy State / LLMのsemantic selectionを分ける根拠として使います。

この資料は理論的なarchitecture paperです。
Vayriaの自然さを直接検証した資料ではありません。

### 2.3 Hazard / point process

[Masuda et al. (2012/2013)](https://doi.org/10.1007/978-3-642-36461-7_12) は、Hawkes型のself-exciting point processを会話イベント列へ適用し、base event rate、self-excitation、temporal decayを推定します。

この方式は、発話機会を確率的な発火率として扱う考え方に近いです。
過去イベントによる一時的な上昇や、個人差をパラメータとして扱えます。

同時に、論文はburstinessとinterevent-time correlationを独立に調整できないHawkes modelの制限も述べています。
Vayriaで採用する場合は、自然さを自動的に保証する方式として扱いません。

### 2.4 Dynamic Field Theory

[Spencer et al. (2012)](https://doi.org/10.1142/S0219635212500227) は、Dynamic Field Theoryを用いたmulti-object trackingのprocess modelを示します。
モデルは複数対象のtrackingと、対象・distractor間の相互作用を動的なfieldとして扱います。

Vayriaへの示唆は、複数対象のattentionを単一enumではなく、相互作用する連続状態として検討できることです。

ただし、この研究はmulti-object trackingが対象です。
会話の発話タイミングやVayriaの身体表現を直接検証した研究ではありません。
attention fieldへの一般化は、Vayria側の仮説として扱います。

## 3. Vayria向けの責務境界

最初の比較では、次のフローを基準にします。

```text
hard gate / readiness
        ↓
hazardが発話機会を生成
        ↓
既存Autonomy Stateがcandidateを選択
        ↓
LLMが意味内容を選択・生成
        ↓
Performance Plan / speech
```

各層の責務は次のとおりです。

| 層 | 責務 | 非責務 |
|---|---|---|
| Hard gate | mute、busy、viewer speech、Session Reset、可視性などの制約 | 発話内容の生成 |
| Timing / hazard | 発話機会、readiness、hazard、phase | candidate、LLM、body motion |
| Autonomy State | Evidence、reason、candidateの選択 | 時間波形の生成 |
| LLM / semantic selection | 発話内容と意味的な応答の決定 | ミリ秒単位の発話時刻制御 |
| Performance | TTS、motion、expression、発話実行 | 次の発話機会の生成 |

candidateが存在しない場合、発話機会はskipします。
hazardはcandidateを新規作成しません。

## 4. 比較対象

### A. 現行ランダムrefractory

```text
turn completed
  ↓
uniform random quiet time
  ↓
gate ready
  ↓
既存candidateをdispatch
```

特徴:

- 実装済みである。
- 固定randomを注入すれば再現できる。
- candidateが先に必要である。
- 外部イベントによるreopenを持つ。

### B. 経過時間に応じた単調hazard

```text
elapsed silence
  ↓
hazard / readinessが上昇
  ↓
random sampling
  ↓
発話機会
```

最初の候補にします。
理由は、現在のrefractoryからの差分を小さく説明できるためです。

必要な入力は、まず次に限定します。

- elapsed silence
- elapsed since own utterance
- inhibition
- hard gate state

### C. Oscillatorを含む周期hazard

```text
phase(t)
  ↓
periodic readiness / hazard
  ↓
random sampling
  ↓
発話機会
```

Wilson & Wilsonの考え方を反映できます。
一方、周期性が実際のVayriaの評価に必要かは未確認です。
単調hazardで説明できる場合は、oscillatorを採用しません。

## 5. 最小PoC仕様

このIssueではコードを追加しません。
後続PoCで実装するための仕様だけを定義します。

### 5.1 比較条件

同じ入力列を3方式へ与えます。

- 同じinitial quiet
- 同じturn完了時刻
- 同じEvidence / candidate状態
- 同じviewer speechイベント
- 同じSession Resetイベント
- 固定clock
- 固定random seed

### 5.2 観測値

各機会またはturnについて、次を記録します。

- elapsed silence
- elapsed since own utterance
- current hazard / readiness
- oscillator phase（C案のみ）
- candidate salience
- blocked reason
- fired / skipped
- external event
- Session Reset generation

本文、発話内容、API key、raw promptはログへ出しません。

### 5.3 シナリオ

1. initial quiet中にcandidateが存在する。
2. refractory中にcandidateが存在する。
3. hazardが機会を作ったがcandidateがない。
4. viewer speechがrefractoryを解除する。
5. viewer speechがturn中に発生する。
6. Session Resetが待機中に発生する。
7. mute、busy、hidden、router gateが発話を抑制する。

### 5.4 評価指標

- 発話機会から発話までの時間分布
- candidateが存在した機会の発話率
- candidateがない機会のskip率
- viewer speechによる抑制と再開
- 発話間隔の反復感
- blocked / skipped理由の説明可能性
- 現行方式との差分
- M1展示版の挙動を変更しないこと

## 6. 判断基準

次の順で判断します。

1. 現行方式の挙動を基準データとして固定する。
2. 単調hazardが、説明可能性と再現性を維持して改善するか確認する。
3. 単調hazardで周期的な不自然さが残る場合だけoscillatorを比較する。
4. timing layerがsemantic candidateを侵食しないことを確認する。
5. 改善が確認できない場合は、現行方式を維持する。

採用判断は、主観評価だけで決めません。
時間分布、skip理由、外部イベント復帰、再現性を併記します。

## 7. 未決事項

- candidateがない発話機会を、次の機会まで保持するか破棄するか。
- 自発発話用のEvidenceを将来どの層が生成するか。
- hazardを加算、乗算、競合場のどれで合成するか。
- candidate salienceをhazardへ入力するか、candidate選択後だけに使うか。
- monotonic hazardで十分か。
- oscillatorの周期を何に同期させるか。
- 自然さの主観評価を誰が、どのルーブリックで行うか。

## 8. 後続作業

このメモの次は、#65のLifeDynamics設計へ接続します。

実装へ進む場合は、次の条件を満たす別PoC Issueを作成します。

- 現行schedulerを置換しない。
- timing layerを純粋な状態更新として隔離する。
- clockとrandomをテストから注入できる。
- hard gateとSession Resetを維持する。
- candidate選択とsemantic selectionを変更しない。
- baseline、monotonic hazard、oscillatorを同じ入力列で比較できる。

## References

- Wilson, M. & Wilson, T. P. (2005). [An oscillator model of the timing of turn-taking](https://doi.org/10.3758/BF03206432).
- Gambi, C. & Pickering, M. J. (2011). [A cognitive architecture for the coordination of utterances](https://doi.org/10.3389/fpsyg.2011.00275).
- Masuda, N., Takaguchi, T., Sato, N. & Yano, K. (2012/2013). [Self-exciting point process modeling of conversation event sequences](https://doi.org/10.1007/978-3-642-36461-7_12).
- Spencer, J. P., Barich, K., Goldberg, J. & Perone, S. (2012). [Behavioral dynamics and neural grounding of a dynamic field theory of multi-object tracking](https://doi.org/10.1142/S0219635212500227).

Source summaries separate source facts, Vayria-specific inferences, and unresolved questions.
