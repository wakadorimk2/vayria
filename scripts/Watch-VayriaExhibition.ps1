[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$ParentProcessId,

  [string]$SessionDirectory,

  [string]$SessionId,

  # Legacy parameters remain available for existing manual invocations.
  [string]$FrontendPidFile,

  [int]$AivisProcessId = 0,

  [int]$AivisWindowProcessId = 0,

  [int]$SttProcessId = 0,

  [int]$SttWindowProcessId = 0,

  [string]$AivisPidFile,

  [string]$SttPidFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-ProcessAlive {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0) {
    return $false
  }

  try {
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    return -not $process.HasExited
  }
  catch {
    return $false
  }
}

function Get-ProcessCommandLine {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  try {
    $process = Get-CimInstance `
      -ClassName Win32_Process `
      -Filter "ProcessId = $ProcessId" `
      -ErrorAction Stop
    return [string]$process.CommandLine
  }
  catch {
    return ''
  }
}

function Test-SessionProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedSessionId
  )

  if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return $false
  }

  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  return $commandLine.Contains($ExpectedSessionId, [StringComparison]::OrdinalIgnoreCase)
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0 -or -not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return
  }

  $windowsDirectory = [Environment]::GetEnvironmentVariable('WINDIR')
  if ([string]::IsNullOrWhiteSpace($windowsDirectory)) {
    $windowsDirectory = [Environment]::GetEnvironmentVariable('SystemRoot')
  }
  $taskkillPath = Join-Path $windowsDirectory 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
    $taskkillArguments = @('/PID', "$ProcessId", '/T', '/F')
    & $taskkillPath @taskkillArguments *> $null
    $taskkillExitCode = $LASTEXITCODE
    if ($taskkillExitCode -ne 0) {
      Write-Warning "taskkill.exe could not stop process tree $ProcessId. Exit code: $taskkillExitCode"
    }
    return
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-Warning "Could not stop process tree $ProcessId. $($_.Exception.Message)"
  }
}

function Read-SessionPidRecords {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedSessionId
  )

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    return @()
  }

  $records = @()
  foreach ($file in (Get-ChildItem -LiteralPath $Directory -Filter '*.tab.pid.json' -File -ErrorAction SilentlyContinue)) {
    try {
      $record = Get-Content -Raw -LiteralPath $file.FullName -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
      if ($record.sessionId -ne $ExpectedSessionId) {
        continue
      }
      if ([int]$record.processId -le 0) {
        continue
      }
      $records += $record
    }
    catch {
      # A tab may still be writing its PID record.
    }
  }

  return $records
}

function Stop-SessionProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedSessionId
  )

  foreach ($record in (Read-SessionPidRecords -Directory $Directory -ExpectedSessionId $ExpectedSessionId)) {
    $processId = [int]$record.processId
    if (Test-SessionProcess -ProcessId $processId -ExpectedSessionId $ExpectedSessionId) {
      Write-Output "Stopping Vayria $($record.role) process tree with root PID $processId."
      Stop-ProcessTree -ProcessId $processId
    }
    else {
      Write-Warning "Skipped PID $processId because it is not an active Vayria session process."
    }
  }
}

function Read-LegacyPidFile {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or
      -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return 0
  }

  try {
    $rawValue = (Get-Content -Raw -LiteralPath $Path -ErrorAction Stop).Trim()
    $foundId = 0
    if ([int]::TryParse($rawValue, [ref]$foundId) -and $foundId -gt 0) {
      return $foundId
    }
  }
  catch {
    # The legacy launcher may still be writing the PID file.
  }

  return 0
}

try {
  if (-not [string]::IsNullOrWhiteSpace($SessionDirectory)) {
    if ([string]::IsNullOrWhiteSpace($SessionId)) {
      throw 'SessionId is required when SessionDirectory is provided.'
    }

    $resolvedSessionDirectory = [IO.Path]::GetFullPath($SessionDirectory)
    while (Test-ProcessAlive -ProcessId $ParentProcessId) {
      Start-Sleep -Milliseconds 250
    }

    # Give tabs a short window to finish writing their session PID records.
    $recordDeadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $recordDeadline) {
      if ((Read-SessionPidRecords -Directory $resolvedSessionDirectory -ExpectedSessionId $SessionId).Count -ge 1) {
        break
      }
      Start-Sleep -Milliseconds 250
    }

    Stop-SessionProcesses `
      -Directory $resolvedSessionDirectory `
      -ExpectedSessionId $SessionId
    return
  }

  $legacyFrontendProcessId = 0
  while (Test-ProcessAlive -ProcessId $ParentProcessId) {
    $legacyFrontendProcessId = Read-LegacyPidFile -Path $FrontendPidFile
    if ($legacyFrontendProcessId -gt 0 -and
        -not (Test-ProcessAlive -ProcessId $legacyFrontendProcessId)) {
      break
    }

    Start-Sleep -Milliseconds 250
  }

  Stop-ProcessTree -ProcessId $legacyFrontendProcessId
  Stop-ProcessTree -ProcessId $AivisWindowProcessId
  Stop-ProcessTree -ProcessId $SttWindowProcessId
  Stop-ProcessTree -ProcessId $AivisProcessId
  Stop-ProcessTree -ProcessId $SttProcessId
}
catch {
  Write-Warning "Vayria exhibition cleanup watcher failed. $($_.Exception.Message)"
  exit 1
}
finally {
  foreach ($path in @($FrontendPidFile, $AivisPidFile, $SttPidFile)) {
    if (-not [string]::IsNullOrWhiteSpace($path) -and
        (Test-Path -LiteralPath $path -PathType Leaf)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
}
