[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AivisInstallPath = '',

  [switch]$AivisWindow,

  [string]$PidFile,

  [ValidateRange(1, 300)]
  [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$aivisHost = '127.0.0.1'
$aivisPort = 10101
$aivisBaseUrl = "http://$aivisHost`:$aivisPort"

function Get-AivisEngineCandidates {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallPath
  )

  $normalizedInstallPath = [IO.Path]::GetFullPath($InstallPath)
  if ([IO.Path]::GetFileName($normalizedInstallPath) -ieq 'run.exe') {
    return @($normalizedInstallPath)
  }

  return @(
    (Join-Path $normalizedInstallPath 'run.exe'),
    (Join-Path $normalizedInstallPath 'AivisSpeech-Engine\run.exe'),
    (Join-Path $normalizedInstallPath 'AivisSpeech\AivisSpeech-Engine\run.exe'),
    (Join-Path $normalizedInstallPath 'AivisSpeech\AivisSpeech Engine\run.exe')
  )
}

function Resolve-AivisEnginePath {
  param(
    [string]$ConfiguredInstallPath,

    [string]$EnvironmentInstallPath
  )

  $installPaths = @()
  $pathSource = 'automatic discovery'
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredInstallPath)) {
    $installPaths = @($ConfiguredInstallPath)
    $pathSource = '-AivisInstallPath'
  }
  elseif (-not [string]::IsNullOrWhiteSpace($EnvironmentInstallPath)) {
    $installPaths = @($EnvironmentInstallPath)
    $pathSource = 'VAYRIA_AIVIS_INSTALL_PATH'
  }
  else {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
      $installPaths += Join-Path $env:USERPROFILE '.vayria\apps\AivisSpeech-1.1.0-dev'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      $installPaths += Join-Path $env:LOCALAPPDATA 'Programs\AivisSpeech'
    }
  }

  $candidates = @()
  foreach ($installPath in $installPaths) {
    if ([string]::IsNullOrWhiteSpace($installPath)) {
      continue
    }
    if (-not [IO.Path]::IsPathRooted($installPath)) {
      throw "AivisInstallPath must be an absolute path: $installPath"
    }
    $candidates += @(Get-AivisEngineCandidates -InstallPath $installPath)
  }

  $resolvedCandidate = $candidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if ($null -ne $resolvedCandidate) {
    return (Resolve-Path -LiteralPath $resolvedCandidate -ErrorAction Stop).Path
  }

  $candidateText = if ($candidates.Count -gt 0) {
    $candidates -join [Environment]::NewLine
  }
  else {
    '(none)'
  }
  throw "AivisSpeech Engine was not found. Source: $pathSource. Checked candidates:`n$candidateText"
}

$enginePath = Resolve-AivisEnginePath `
  -ConfiguredInstallPath $AivisInstallPath `
  -EnvironmentInstallPath $env:VAYRIA_AIVIS_INSTALL_PATH
$engineDirectory = Split-Path -Parent $enginePath
$engineArguments = @(
  '--host'
  $aivisHost
  '--port'
  $aivisPort
  '--no-use_gpu'
  '--output_log_utf8'
  '--cors_policy_mode'
  'all'
)

function Assert-EngineFile {
  if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) {
    throw "Resolved AivisSpeech Engine was not found: $enginePath"
  }
}

function Test-ListeningPort {
  try {
    return [bool](Test-NetConnection `
        -ComputerName $aivisHost `
        -Port $aivisPort `
        -InformationLevel Quiet `
        -WarningAction SilentlyContinue)
  }
  catch {
    return $false
  }
}

function Get-AivisSpeakers {
  try {
    return @(Invoke-RestMethod `
        -Uri "$aivisBaseUrl/speakers" `
        -TimeoutSec 2 `
        -ErrorAction Stop)
  }
  catch {
    return @()
  }
}

function Test-AivisReady {
  $speakers = @(Get-AivisSpeakers)
  return [bool](@($speakers | Where-Object { $_.name -eq 'zonoko' }).Count)
}

function Wait-ForAivisReady {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "AivisSpeech Engine exited before http://$aivisHost`:$aivisPort/speakers became ready."
    }

    if (Test-AivisReady) {
      return
    }

    Start-Sleep -Milliseconds 250
  }

  throw "AivisSpeech Engine did not expose zonoko at http://$aivisHost`:$aivisPort/speakers within $StartupTimeoutSeconds seconds."
}

function Remove-PidFile {
  if ([string]::IsNullOrWhiteSpace($PidFile)) {
    return
  }

  if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
    try {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction Stop
    }
    catch {
      Write-Warning "Could not remove the temporary Aivis process ID file: $PidFile"
    }
  }
}

if ($AivisWindow) {
  try {
    $Host.UI.RawUI.WindowTitle = 'Vayria AivisSpeech'
  }
  catch {
    # A non-interactive host may not expose a writable window title.
  }
}

if (-not [string]::IsNullOrWhiteSpace($PidFile) -and -not [IO.Path]::IsPathRooted($PidFile)) {
  throw 'PidFile must be an absolute path.'
}

Assert-EngineFile

if (Test-AivisReady) {
  Write-Output "Reusing healthy AivisSpeech Engine at $aivisBaseUrl (zonoko is available)."
  exit 0
}

if (Test-ListeningPort) {
  throw "AivisSpeech port $aivisPort is already in use, but zonoko is not available at $aivisBaseUrl/speakers. Stop the conflicting process or check the configured AivisSpeech installation."
}

$aivisProcess = $null
$exitCode = 1
try {
  if (-not $PSCmdlet.ShouldProcess($enginePath, "start AivisSpeech Engine on $aivisHost`:$aivisPort")) {
    Write-Output "WhatIf: start AivisSpeech Engine from $enginePath on $aivisHost`:$aivisPort"
    $exitCode = 0
  }
  else {
    Write-Output "Starting AivisSpeech Engine from: $enginePath"
    $aivisProcess = Start-Process `
      -FilePath $enginePath `
      -WorkingDirectory $engineDirectory `
      -ArgumentList $engineArguments `
      -NoNewWindow `
      -PassThru

    if (-not [string]::IsNullOrWhiteSpace($PidFile)) {
      Set-Content -LiteralPath $PidFile -Value $aivisProcess.Id -Encoding ascii
    }

    Wait-ForAivisReady -Process $aivisProcess
    Write-Output "AivisSpeech Engine is ready at $aivisBaseUrl with zonoko."
    $aivisProcess.WaitForExit()
    $exitCode = $aivisProcess.ExitCode
  }
}
catch {
  Write-Error $_
  $exitCode = 1
}
finally {
  if ($null -ne $aivisProcess) {
    $aivisProcess.Refresh()
    if (-not $aivisProcess.HasExited) {
      try {
        Stop-Process -Id $aivisProcess.Id -Force -ErrorAction Stop
      }
      catch {
        Write-Warning "Could not stop the started AivisSpeech Engine process with PID $($aivisProcess.Id). $($_.Exception.Message)"
      }
    }
  }

  Remove-PidFile
}

exit $exitCode
