[CmdletBinding()]
param(
  [string]$ArdyRoot = (Join-Path $env:USERPROFILE '.vayria\ardy'),
  [string]$RepositoryUrl = 'https://github.com/nv-tlabs/ardy.git',
  [Parameter(Mandatory = $true)]
  [string]$ArdyRef,
  [switch]$InstallDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Native([string]$executable, [string[]]$nativeArguments) {
  & $executable @nativeArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$executable failed with exit code $exitCode."
  }
}

$resolvedArdyRoot = [IO.Path]::GetFullPath($ArdyRoot)
$sourceDirectory = Join-Path $resolvedArdyRoot 'source'
$venvDirectory = Join-Path $resolvedArdyRoot 'venv'
$checkpointDirectory = Join-Path $resolvedArdyRoot 'checkpoints'
$hfCacheDirectory = Join-Path $resolvedArdyRoot 'hf-cache'
$runtimeCacheDirectory = Join-Path $resolvedArdyRoot 'runtime-cache'
$rawOutputDirectory = Join-Path $resolvedArdyRoot 'raw-output'

foreach ($directory in @(
    $resolvedArdyRoot,
    $checkpointDirectory,
    $hfCacheDirectory,
    $runtimeCacheDirectory,
    $rawOutputDirectory
  )) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
}

$gitCommand = (Get-Command git -ErrorAction Stop).Source
$pythonLauncher = (Get-Command py -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory '.git') -PathType Container)) {
  if (Test-Path -LiteralPath $sourceDirectory) {
    throw "ARDY source path exists but is not a Git checkout: $sourceDirectory"
  }
  Invoke-Native $gitCommand @('clone', $RepositoryUrl, $sourceDirectory)
  Invoke-Native $gitCommand @('-C', $sourceDirectory, 'checkout', '--detach', $ArdyRef)
} else {
  Write-Output "Preserved existing ARDY checkout: $sourceDirectory"
}

$resolvedSource = (Resolve-Path -LiteralPath $sourceDirectory).Path
$sourceCommit = (& $gitCommand '-C' $resolvedSource 'rev-parse' 'HEAD').Trim()
Write-Output "ARDY source commit: $sourceCommit"

if (-not (Test-Path -LiteralPath (Join-Path $venvDirectory 'Scripts\python.exe') -PathType Leaf)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $venvDirectory) -Force | Out-Null
  Invoke-Native $pythonLauncher @('-3.10', '-m', 'venv', $venvDirectory)
}

$venvPython = Resolve-Path -LiteralPath (Join-Path $venvDirectory 'Scripts\python.exe')
if ($InstallDependencies) {
  Invoke-Native $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
  Invoke-Native $venvPython @('-m', 'pip', 'install', '-e', "$resolvedSource[all]")
} else {
  Write-Output 'Python dependencies were not installed. Use -InstallDependencies after reviewing the ARDY licenses.'
}

$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
if ($null -eq $cmakeCommand) {
  Write-Warning 'CMake was not found. ARDY native motion-correction extension setup may require CMake 3.15 or newer.'
} else {
  Write-Output "CMake: $($cmakeCommand.Source)"
}

Write-Output "ARDY external environment is ready: $resolvedArdyRoot"
Write-Output 'Model checkpoints were not downloaded.'
