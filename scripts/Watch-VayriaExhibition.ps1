[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$ParentProcessId,

  [Parameter(Mandatory = $true)]
  [string]$FrontendPidFile,

  [int]$AivisProcessId = 0,

  [int]$AivisWindowProcessId = 0,

  [int]$SttProcessId = 0,

  [int]$SttWindowProcessId = 0,

  [string]$AivisPidFile,

  [string]$SttPidFile
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Test-ProcessAlive {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  if ($ProcessId -le 0) {
    return $false
  }

  try {
    $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    return -not $process.HasExited
  }
  catch {
    return $false
  }
}

function Read-ProcessId {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    [int]$processId = 0
    $rawValue = (Get-Content -Raw -LiteralPath $Path).Trim()
    if ([int]::TryParse($rawValue, [ref]$processId) -and $processId -gt 0) {
      return $processId
    }
  }
  catch {
    # The launcher may still be writing the PID file.
  }

  return 0
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0 -or -not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return
  }

  $taskkillPath = Join-Path $env:WINDIR 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
    & $taskkillPath /PID $ProcessId /T /F *> $null
  }
  else {
    Stop-Process -Id $ProcessId -Force
  }
}

$frontendProcessId = 0
while (Test-ProcessAlive -ProcessId $ParentProcessId) {
  $frontendProcessId = Read-ProcessId -Path $FrontendPidFile
  if ($frontendProcessId -gt 0 -and -not (Test-ProcessAlive -ProcessId $frontendProcessId)) {
    break
  }

  Start-Sleep -Milliseconds 250
}

Stop-ProcessTree -ProcessId $frontendProcessId
Stop-ProcessTree -ProcessId $AivisWindowProcessId
Stop-ProcessTree -ProcessId $SttWindowProcessId
Stop-ProcessTree -ProcessId $AivisProcessId
Stop-ProcessTree -ProcessId $SttProcessId

foreach ($path in @($FrontendPidFile, $AivisPidFile, $SttPidFile)) {
  if (-not [string]::IsNullOrWhiteSpace($path)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}
