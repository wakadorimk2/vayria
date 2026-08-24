[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandPath,

  [string]$CommandArguments = '',

  [string]$ReferenceFile = (Join-Path $env:USERPROFILE '.vayria\vayria-op.env'),

  [string]$OpCommand = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-Executable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathOrName,

    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  if ([IO.Path]::IsPathRooted($PathOrName)) {
    $resolvedPath = [IO.Path]::GetFullPath($PathOrName)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
      throw "$Description was not found: $resolvedPath"
    }
    return $resolvedPath
  }

  $command = Get-Command $PathOrName -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    throw "$Description was not found: $PathOrName"
  }

  return $command.Source
}

function Resolve-OpCommand {
  if (-not [string]::IsNullOrWhiteSpace($OpCommand)) {
    return Resolve-Executable -PathOrName $OpCommand -Description '1Password CLI'
  }

  $configuredOp = Join-Path $env:USERPROFILE '.vayria\tools\op.exe'
  if (Test-Path -LiteralPath $configuredOp -PathType Leaf) {
    return $configuredOp
  }

  return Resolve-Executable -PathOrName 'op.exe' -Description '1Password CLI'
}

function Resolve-ReferenceFile {
  if (-not [IO.Path]::IsPathRooted($ReferenceFile)) {
    throw 'ReferenceFile must be an absolute path.'
  }

  $resolvedPath = [IO.Path]::GetFullPath($ReferenceFile)
  if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
    throw "The 1Password reference file was not found: $resolvedPath"
  }

  $keyLineCount = 0
  $referenceValue = $null
  foreach ($line in (Get-Content -LiteralPath $resolvedPath -ErrorAction Stop)) {
    $trimmedLine = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmedLine) -or $trimmedLine.StartsWith('#')) {
      continue
    }

    if ($trimmedLine -notmatch '^OPENAI_API_KEY\s*=\s*(.*?)\s*$') {
      throw 'The 1Password reference file may contain only OPENAI_API_KEY=op://... and comments.'
    }

    $keyLineCount++
    $referenceValue = $Matches[1].Trim()
  }

  if ($keyLineCount -ne 1 -or [string]::IsNullOrWhiteSpace($referenceValue)) {
    throw 'The 1Password reference file must contain exactly one OPENAI_API_KEY entry.'
  }

  if (-not $referenceValue.StartsWith('op://', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OPENAI_API_KEY in the 1Password reference file must be an op:// reference.'
  }

  return $resolvedPath
}

$resolvedReferenceFile = Resolve-ReferenceFile
$resolvedOpCommand = Resolve-OpCommand
$resolvedCommand = Resolve-Executable -PathOrName $CommandPath -Description 'Target command'

$resolvedCommandArguments = @()
if (-not [string]::IsNullOrWhiteSpace($CommandArguments)) {
  $resolvedCommandArguments = @($CommandArguments -split '\s+' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  })
}

$opArguments = @(
  'run'
  '--env-file'
  $resolvedReferenceFile
  '--'
  $resolvedCommand
) + $resolvedCommandArguments

if ($PSCmdlet.ShouldProcess($resolvedCommand, 'run with 1Password secret references')) {
  & $resolvedOpCommand @opArguments
  $exitCode = $LASTEXITCODE
  exit $exitCode
}

Write-Output "WhatIf: run $resolvedCommand with 1Password secret references."
