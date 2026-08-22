[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$WorktreePath,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$SecretFile = (Join-Path $env:USERPROFILE '.vayria\secrets.env'),

  [string]$AivisBaseUrl = 'http://127.0.0.1:10101',

  [ValidateSet('local', 'exhibition', 'public')]
  [string]$AppMode = 'local',

  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$initializeScript = Join-Path $scriptDirectory 'Initialize-WorktreeEnv.ps1'

$initializeParameters = @{
  WorktreePath = $resolvedWorktree
  Port         = $Port
  SecretFile   = $SecretFile
  AivisBaseUrl = $AivisBaseUrl
  AppMode      = $AppMode
}

if ($Force) {
  $initializeParameters.Force = $true
}

if ($WhatIfPreference) {
  $initializeParameters.WhatIf = $true
  & $initializeScript @initializeParameters
  return
}

$npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
& $initializeScript @initializeParameters

Push-Location -LiteralPath $resolvedWorktree
try {
  Write-Output "Starting Vayria in $resolvedWorktree on port $Port"
  & $npmCommand run dev
  $exitCode = $LASTEXITCODE
}
finally {
  Pop-Location
}

exit $exitCode
