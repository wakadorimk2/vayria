[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Url = 'https://127.0.0.1:5189/',

  [string]$ReferenceFile = (Join-Path $env:USERPROFILE '.vayria\vayria-op.env'),

  [string]$OpCommand = '',

  [int]$ReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Test-ServerReady {
  param([Parameter(Mandatory = $true)][uri]$Target)

  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect($Target.Host, $Target.Port, $null, $null)
    if ($connect.AsyncWaitHandle.WaitOne(500)) {
      $client.EndConnect($connect)
      $client.Close()
      return $true
    }
    $client.Close()
  } catch {
    return $false
  }
  return $false
}

$pwsh = Get-Command 'pwsh.exe' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $pwsh) {
  throw 'pwsh was not found on PATH.'
}

$launcher = Join-Path $repoRoot 'scripts\Start-VayriaWithOnePassword.ps1'
# ArgumentList is passed as a single string: embedded quotes keep
# multi-word values (e.g. "run dev:stream") grouped for the child script.
$launcherArguments = '-NoProfile -File "{0}" -CommandPath npm.cmd -CommandArguments "run dev:stream"' -f $launcher
if (-not [string]::IsNullOrWhiteSpace($OpCommand)) {
  $launcherArguments += ' -OpCommand "{0}"' -f $OpCommand
}
if ($PSBoundParameters.ContainsKey('ReferenceFile')) {
  $launcherArguments += ' -ReferenceFile "{0}"' -f $ReferenceFile
}

$electron = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw "Electron was not found: $electron (run npm install first)"
}

$devProcess = $null
try {
  if ($PSCmdlet.ShouldProcess('dev:stream + overlay', 'start with 1Password secret references')) {
    $devProcess = Start-Process -FilePath $pwsh.Source `
      -ArgumentList $launcherArguments `
      -WorkingDirectory $repoRoot `
      -NoNewWindow `
      -PassThru

    $target = [uri]$Url
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      if ($devProcess.HasExited) {
        throw "The dev server exited early with code $($devProcess.ExitCode)."
      }
      if (Test-ServerReady -Target $target) {
        break
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-ServerReady -Target $target)) {
      throw "The dev server did not start listening on $Url within $ReadyTimeoutSeconds seconds."
    }

    & $electron (Join-Path $repoRoot 'overlay\main.cjs') $Url
    exit $LASTEXITCODE
  }

  Write-Output "WhatIf: start dev:stream under 1Password and open the overlay at $Url."
} finally {
  if ($null -ne $devProcess -and -not $devProcess.HasExited) {
    & taskkill.exe /PID $devProcess.Id /T /F | Out-Null
  }
}
