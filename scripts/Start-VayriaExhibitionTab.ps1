[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('AivisSpeech', 'Stt', 'Vite')]
  [string]$Role,

  [Parameter(Mandatory = $true)]
  [string]$WorktreePath,

  [Parameter(Mandatory = $true)]
  [string]$SessionId,

  [Parameter(Mandatory = $true)]
  [string]$SessionDirectory,

  [Parameter(Mandatory = $true)]
  [string]$LogDirectory,

  [string]$AivisInstallPath = '',

  [ValidateSet('tiny', 'base', 'small', 'medium')]
  [string]$SttModel = 'small',

  [ValidateSet('auto', 'cuda', 'cpu')]
  [string]$SttDevice = 'cuda',

  [ValidateSet('auto', 'float16', 'int8', 'int8_float16')]
  [string]$SttComputeType = 'float16',

  [string]$SttHotwords = 'Vayria GPT-Live Codex',

  [ValidateSet('tiny', 'base', 'small')]
  [string]$SttFallbackModel = 'tiny',

  [ValidateSet('cpu', 'cuda')]
  [string]$SttFallbackDevice = 'cpu',

  [ValidateSet('auto', 'float16', 'int8', 'int8_float16')]
  [string]$SttFallbackComputeType = 'int8',

  [string]$StartAfterFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sttHost = '127.0.0.1'
$sttPort = 8787

function Resolve-Directory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "$Description was not found: $resolved"
  }

  return $resolved
}

function Resolve-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  return (Get-Command $Name -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [hashtable]$Value
  )

  $json = [ordered]@{} + $Value | ConvertTo-Json -Compress
  $directory = Split-Path -Parent $Path
  $fileName = Split-Path -Leaf $Path
  $temporaryPath = Join-Path $directory ".${fileName}.$PID.$([Guid]::NewGuid().ToString('N')).tmp"

  try {
    Set-Content -LiteralPath $temporaryPath -Value $json -Encoding utf8
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force -ErrorAction Stop
        return
      }
      catch {
        if ($attempt -eq 19) {
          throw
        }
        Start-Sleep -Milliseconds 25
      }
    }
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-TabLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $launcherLogPath -Value $line -Encoding utf8
  Write-Output $Message
}

function Write-RoleStatus {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('starting', 'waiting', 'running', 'failed', 'stopped', 'exited')]
    [string]$State,

    [int]$ExitCode = 0,

    [int]$ChildProcessId = 0,

    [string]$Message = ''
  )

  Write-JsonFile -Path $statusFile -Value @{
    sessionId      = $SessionId
    role           = $Role
    processId      = $PID
    childProcessId = $ChildProcessId
    state          = $State
    exitCode       = $ExitCode
    message        = $Message
    timestamp      = (Get-Date).ToString('o')
  }
}

function Read-ProcessIdFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return 0
  }

  try {
    $record = Get-Content -Raw -LiteralPath $Path -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    if ($record.sessionId -ne $SessionId) {
      return 0
    }
    return [int]$record.processId
  }
  catch {
    return 0
  }
}

function Stop-ChildProcessTree {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0) {
    return
  }

  try {
    [Diagnostics.Process]::GetProcessById($ProcessId).Refresh()
  }
  catch {
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
      Write-TabLog "Could not stop child process tree $ProcessId. taskkill.exe exit code: $taskkillExitCode"
    }
    return
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-TabLog "Could not stop child process $ProcessId. $($_.Exception.Message)"
  }
}

function Wait-ForStartGate {
  if ([string]::IsNullOrWhiteSpace($StartAfterFile)) {
    return
  }

  $deadline = (Get-Date).AddMinutes(5)
  Write-RoleStatus -State 'waiting' -Message "Waiting for start gate: $StartAfterFile"
  Write-TabLog "Waiting for start gate: $StartAfterFile"
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $StartAfterFile -PathType Leaf) {
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Start gate was not created within 300 seconds: $StartAfterFile"
}

function Get-RoleDefinition {
  $roleSlug = switch ($Role) {
    'AivisSpeech' { 'aivisspeech' }
    'Stt' { 'stt' }
    'Vite' { 'vite' }
  }

  $roleTitle = switch ($Role) {
    'AivisSpeech' { 'AivisSpeech' }
    'Stt' { 'STT' }
    'Vite' { 'Vite' }
  }

  return [pscustomobject]@{
    Slug  = $roleSlug
    Title = $roleTitle
  }
}

$resolvedWorktree = Resolve-Directory -Path $WorktreePath -Description 'Vayria worktree'
$resolvedSessionDirectory = Resolve-Directory -Path $SessionDirectory -Description 'Vayria exhibition session directory'
$resolvedLogDirectory = Resolve-Directory -Path $LogDirectory -Description 'Vayria exhibition log directory'
$roleDefinition = Get-RoleDefinition

$pidFile = Join-Path $resolvedSessionDirectory "$($roleDefinition.Slug).tab.pid.json"
$statusFile = Join-Path $resolvedSessionDirectory "$($roleDefinition.Slug).status.json"
$childPidFile = Join-Path $resolvedSessionDirectory "$($roleDefinition.Slug).child.pid.json"
$stdoutLogPath = Join-Path $resolvedLogDirectory "$($roleDefinition.Slug).stdout.log"
$stderrLogPath = Join-Path $resolvedLogDirectory "$($roleDefinition.Slug).stderr.log"
$launcherLogPath = Join-Path $resolvedLogDirectory "$($roleDefinition.Slug).status.log"

try {
  try {
    $Host.UI.RawUI.WindowTitle = "Vayria - $($roleDefinition.Title)"
  }
  catch {
    # A non-interactive host may not expose a writable window title.
  }

  Write-JsonFile -Path $pidFile -Value @{
    sessionId = $SessionId
    role      = $Role
    processId = $PID
    timestamp = (Get-Date).ToString('o')
  }
  Write-RoleStatus -State 'starting' -Message "Starting $($roleDefinition.Title)."
  Write-TabLog "Starting $($roleDefinition.Title)."
  Write-TabLog "stdout: $stdoutLogPath"
  Write-TabLog "stderr: $stderrLogPath"
  Set-Content -LiteralPath $stdoutLogPath -Value '' -Encoding utf8
  Set-Content -LiteralPath $stderrLogPath -Value '' -Encoding utf8

  Wait-ForStartGate

  $pwshCommand = Resolve-Command -Name 'pwsh.exe'
  $npmCommand = Resolve-Command -Name 'npm.cmd'
  $childCommand = $null
  $childArguments = @()
  $childWorkingDirectory = $resolvedWorktree

  switch ($Role) {
    'AivisSpeech' {
      $aivisScriptFile = Join-Path $resolvedWorktree 'scripts\Start-VayriaAivisSpeech.ps1'
      $childCommand = $pwshCommand
      $childWorkingDirectory = Split-Path -Parent $aivisScriptFile
      $childArguments = @(
        '-NoProfile'
        '-File'
        $aivisScriptFile
        '-PidFile'
        $childPidFile
      )
      if (-not [string]::IsNullOrWhiteSpace($AivisInstallPath)) {
        $childArguments += @('-AivisInstallPath', $AivisInstallPath)
      }
    }
    'Stt' {
      $childCommand = Resolve-Command -Name 'uv.exe'
      $childWorkingDirectory = Join-Path $resolvedWorktree 'tools\stt'
      if ($SttDevice -eq 'cuda' -or $SttFallbackDevice -eq 'cuda') {
        $cudaRuntimePath = Join-Path $env:USERPROFILE '.vayria\cuda12'
        if (-not (Test-Path -LiteralPath $cudaRuntimePath -PathType Container)) {
          throw "Vayria CUDA runtime was not found: $cudaRuntimePath"
        }
        $env:Path = $cudaRuntimePath + ';' + $env:Path
      }
      $childArguments = @(
        'run'
        '--no-sync'
        '--no-cache'
        'python'
        '-m'
        'vayria_stt.server'
        '--host'
        $sttHost
        '--port'
        "$sttPort"
        '--model'
        $SttModel
        '--device'
        $SttDevice
        '--compute-type'
        $SttComputeType
        '--hotwords'
        $SttHotwords
        '--require-primary-profile'
        '--fallback-model'
        $SttFallbackModel
        '--fallback-device'
        $SttFallbackDevice
        '--fallback-compute-type'
        $SttFallbackComputeType
      )
    }
    'Vite' {
      $childCommand = $npmCommand
      $childWorkingDirectory = $resolvedWorktree
      $childArguments = @('run', 'dev:exhibition')
    }
  }

  Write-RoleStatus -State 'running' -Message "Running $($roleDefinition.Title)."
  Write-TabLog "Running $($roleDefinition.Title)."
  Write-TabLog "Command: $childCommand $($childArguments -join ' ')"

  $childExitCode = 1
  try {
    Push-Location -LiteralPath $childWorkingDirectory
    try {
      & $childCommand @childArguments 2> $stderrLogPath |
        Tee-Object -FilePath $stdoutLogPath -Encoding utf8
      $childExitCode = $LASTEXITCODE
      if ($null -eq $childExitCode) {
        $childExitCode = 0
      }
    }
    finally {
      Pop-Location
    }
  }
  catch {
    $childExitCode = 1
    Write-TabLog "The $($roleDefinition.Title) command raised an error: $($_.Exception.Message)"
  }

  $state = if ($childExitCode -eq 0) { 'exited' } else { 'failed' }
  $message = "$($roleDefinition.Title) exited with code $childExitCode."
  Write-RoleStatus -State $state -ExitCode $childExitCode -Message $message
  if ($childExitCode -ne 0) {
    Write-TabLog "[FAIL] $($roleDefinition.Title)"
    Write-TabLog "Reason: $message"
    Write-TabLog "stdout: $stdoutLogPath"
    Write-TabLog "stderr: $stderrLogPath"
    Write-TabLog 'Action: inspect the logs, then press Ctrl+C in the control tab.'
  }
  else {
    Write-TabLog $message
  }

  if ($childExitCode -ne 0 -and (Test-Path -LiteralPath $stderrLogPath -PathType Leaf)) {
    Write-TabLog 'Last stderr lines:'
    Get-Content -LiteralPath $stderrLogPath -Tail 20 -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Output $_ }
  }
}
catch {
  $message = "$($roleDefinition.Title) failed: $($_.Exception.Message)"
  try {
    Write-RoleStatus -State 'failed' -ExitCode 1 -Message $message
    Write-TabLog "[FAIL] $($roleDefinition.Title)"
    Write-TabLog "Reason: $message"
    Write-TabLog "stdout: $stdoutLogPath"
    Write-TabLog "stderr: $stderrLogPath"
    Write-TabLog 'Action: inspect the logs, then press Ctrl+C in the control tab.'
  }
  catch {
    Write-Error $message
  }
}
finally {
  $childProcessId = Read-ProcessIdFile -Path $childPidFile
  if ($childProcessId -gt 0) {
    Stop-ChildProcessTree -ProcessId $childProcessId
  }

  if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }

  Write-TabLog "The $($roleDefinition.Title) tab remains open for inspection."
}
