[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Prompt,

  [Parameter(Mandatory = $true)]
  [string]$PipelineScript,

  [Parameter(Mandatory = $true)]
  [string]$OutputFile,

  [string]$ArdyRoot = (Join-Path $env:USERPROFILE '.vayria\ardy'),
  [string]$PythonPath = (Join-Path $env:USERPROFILE '.vayria\ardy\venv\Scripts\python.exe'),
  [string]$AvatarPath = (Join-Path $env:USERPROFILE '.vayria\avatar\model.vrm'),
  [string]$CorrectionProfile = (Join-Path $PSScriptRoot 'profiles\vayria-default-v1.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ExistingFile([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$label was not found: $path"
  }
  return (Resolve-Path -LiteralPath $path).Path
}

$resolvedArdyRoot = Resolve-ExistingFile (Join-Path $ArdyRoot 'README.md') 'ARDY root marker'
$resolvedPython = Resolve-ExistingFile $PythonPath 'Python executable'
$resolvedPipeline = Resolve-ExistingFile $PipelineScript 'pipeline script'
$resolvedAvatar = Resolve-ExistingFile $AvatarPath 'avatar VRM'
$resolvedProfile = Resolve-ExistingFile $CorrectionProfile 'motion correction profile'
$resolvedArdyRoot = Split-Path -Parent $resolvedArdyRoot
$resolvedOutput = [IO.Path]::GetFullPath($OutputFile)
$outputDirectory = Split-Path -Parent $resolvedOutput

if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
if (Test-Path -LiteralPath $resolvedOutput -PathType Leaf) {
  throw "Refusing to overwrite an existing motion asset: $resolvedOutput"
}

$pipelineArguments = @(
  $resolvedPipeline,
  '--prompt', $Prompt,
  '--output', $resolvedOutput,
  '--avatar', $resolvedAvatar,
  '--correction-profile', $resolvedProfile,
  '--ardy-root', $resolvedArdyRoot
)
& $resolvedPython @pipelineArguments
$pipelineExitCode = $LASTEXITCODE
if ($pipelineExitCode -ne 0) {
  throw "The external motion pipeline failed with exit code $pipelineExitCode."
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$validatorPath = Join-Path $PSScriptRoot 'validate-vrma.mjs'
& $nodeCommand $validatorPath '--file' $resolvedOutput
$validatorExitCode = $LASTEXITCODE
if ($validatorExitCode -ne 0) {
  throw "The generated VRMA failed structural validation with exit code $validatorExitCode."
}

Write-Output "Generated and validated VRMA: $resolvedOutput"
