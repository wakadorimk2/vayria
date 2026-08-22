# Vayria motion pipeline

このディレクトリは、Vayria 本体と ARDY の境界を定義します。

Vayria repository には、ARDY の Python source、virtualenv、checkpoint、LLM cache、CUDA build output を置きません。

## 外部ディレクトリ

```text
%USERPROFILE%\.vayria\ardy\
  source\
  venv\
  checkpoints\
  hf-cache\
  runtime-cache\
  raw-output\
```

## 外部 pipeline の契約

`generate-vrma.ps1` は ARDY の研究コードを直接 import しません。

外部の pipeline script は、次の CLI 引数を受け取ります。

```text
--prompt <短い motion prompt>
--output <生成する .vrma の絶対パス>
--avatar <対象 VRM の絶対パス>
--correction-profile <JSON profile の絶対パス>
--ardy-root <ARDY 外部環境の絶対パス>
```

外部 pipeline は、次の順序を実行します。

```text
ARDY native output
  -> ARDY native post-process
  -> VRM humanoid retarget
  -> Vayria Motion Correction
  -> VRMA encode
  -> tools/motion/validate-vrma.mjs
```

ARDY の CLI 引数は版によって変わる可能性があります。

そのため、Vayria は ARDY の `generate.py` を固定契約にしません。

外部環境の初期化には `setup-ardy.ps1` を使えます。

`-ArdyRef` には、レビュー済みの ARDY tag または commit を指定します。

`-InstallDependencies` を指定しない場合、Python package はインストールしません。

checkpoint と LLM は自動でダウンロードしません。

利用規約と gated model の取得条件を確認した後に、外部 cache へ配置します。

```powershell
pwsh -NoProfile -File .\tools\motion\setup-ardy.ps1 `
  -ArdyRef '<reviewed-ardy-commit>'
```

## 生成例

```powershell
pwsh -NoProfile -File .\tools\motion\generate-vrma.ps1 `
  -Prompt 'a small friendly greeting with a restrained arm swing' `
  -PipelineScript 'C:\path\to\vayria-ardy-pipeline.py' `
  -OutputFile "$env:USERPROFILE\.vayria\ardy\raw-output\greeting-small.vrma"
```

生成した `.vrma` は、構造検証後に Vayria の実際の `model.vrm` で preview します。

owner Playcheck を通過した asset だけを、次へコピーします。

```text
public/avatar/motions/<asset-file>.vrma
```

その後、`public/avatar/motions/manifest.json` へ SHA-256、duration、profile ID、tag を登録します。

生成途中の `.vrma`、NPZ、preview、失敗 asset は repository へ追加しません。

## 補正 profile

`profiles/vayria-default-v1.json` は identity 値の初期 profile です。

`targetAvatarSha256` は owner Playcheck 前は `null` です。

腕の開き、腕振り、肘、肩、stance、step width、root、pelvis の値は、実際の VRM で確認して更新します。

このprofileは生成時のretarget補正用です。browserの再生補正は別の
`MotionPlaybackProfile`として`MotionPlayer`がclip生成後に適用します。
