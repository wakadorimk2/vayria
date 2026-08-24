[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [ValidateSet('tiny', 'base', 'small')]
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

  [switch]$SttWindow,

  [string]$SttPidFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sttHost = '127.0.0.1'
$sttPort = 8787
$sttStartupTimeoutSeconds = 30
$aivisHost = '127.0.0.1'
$aivisPort = 10101
$aivisBaseUrl = "http://$aivisHost`:$aivisPort"
$aivisStartupTimeoutSeconds = 30
$launcherMutexName = 'Vayria.ExhibitionLauncher'
$sttHotwordsArgument = '"' + $SttHotwords.Replace('"', '\"') + '"'

function Resolve-RequiredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  if (-not $command) {
    throw "Required command was not found: $Name"
  }

  return $command.Source
}

function Assert-RequiredFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description was not found: $Path"
  }
}

function Test-ListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [string]$HostName = $sttHost
  )

  try {
    return [bool](Test-NetConnection `
        -ComputerName $HostName `
        -Port $Port `
        -InformationLevel Quiet `
        -WarningAction SilentlyContinue)
  }
  catch {
    return $false
  }
}

function Wait-ForListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds,

    [string]$HostName = $sttHost
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Python STT process exited before port $Port became available."
    }

    if (Test-ListeningPort -HostName $HostName -Port $Port) {
      return
    }

    Start-Sleep -Milliseconds 250
  }

  throw "Python STT did not start listening on port $Port within $TimeoutSeconds seconds."
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

  $deadline = (Get-Date).AddSeconds($aivisStartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "AivisSpeech PowerShell window exited before $aivisBaseUrl/speakers became ready."
    }

    if (Test-AivisReady) {
      return
    }

    Start-Sleep -Milliseconds 250
  }

  throw "AivisSpeech Engine did not expose zonoko at $aivisBaseUrl/speakers within $aivisStartupTimeoutSeconds seconds."
}

function Stop-StartedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId
  )

  $taskkillPath = Join-Path $env:WINDIR 'System32\taskkill.exe'
  try {
    if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
      & $taskkillPath /PID $RootProcessId /T /F *> $null
      if ($LASTEXITCODE -ne 0) {
        throw "taskkill.exe returned exit code $LASTEXITCODE"
      }
    }
    else {
      Stop-Process -Id $RootProcessId -Force -ErrorAction Stop
    }
  }
  catch {
    Write-Warning "Could not stop the started process tree with root PID $RootProcessId. $($_.Exception.Message)"
  }
}

function Wait-ForPidFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds,

    [string]$Description = 'child process'
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "$Description exited before it recorded the process ID."
    }

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $rawProcessId = (Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue).Trim()
      [int]$processId = 0
      if ([int]::TryParse($rawProcessId, [ref]$processId) -and $processId -gt 0) {
        return $processId
      }
    }

    Start-Sleep -Milliseconds 100
  }

  throw "$Description did not record a process ID within $TimeoutSeconds seconds."
}

function Stop-StartedPython {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  Stop-StartedProcess -RootProcessId $ProcessId
}

function Remove-PidFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    try {
      Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    catch {
      Write-Warning "Could not remove the temporary Python STT process ID file: $Path"
    }
  }
}

function Stop-LauncherChildren {
  if ($script:cleanupStarted) {
    return
  }

  $script:cleanupStarted = $true

  if ($null -ne $script:watcherProcess) {
    try {
      $script:watcherProcess.Refresh()
      if (-not $script:watcherProcess.HasExited) {
        Stop-StartedProcess -RootProcessId $script:watcherProcess.Id
      }
    }
    catch {
      Write-Warning "Could not stop the Vayria exhibition cleanup watcher. $($_.Exception.Message)"
    }
  }

  if ($null -ne $script:frontendProcess) {
    try {
      $script:frontendProcess.Refresh()
      if (-not $script:frontendProcess.HasExited) {
        Write-Output "Stopping npm frontend process tree with root PID $($script:frontendProcess.Id)."
        Stop-StartedProcess -RootProcessId $script:frontendProcess.Id
      }
    }
    catch {
      Write-Warning "Could not stop the npm frontend process tree. $($_.Exception.Message)"
    }
  }

  if ($script:sttProcessId -gt 0) {
    Write-Output "Stopping Python STT process tree with root PID $script:sttProcessId."
    Stop-StartedPython -ProcessId $script:sttProcessId
  }

  if ($null -ne $script:sttProcess) {
    try {
      $script:sttProcess.Refresh()
      if (-not $script:sttProcess.HasExited) {
        Write-Output "Stopping Python STT PowerShell window with PID $($script:sttProcess.Id)."
        Stop-StartedProcess -RootProcessId $script:sttProcess.Id
      }
    }
    catch {
      Write-Warning "Could not stop the Python STT PowerShell window. $($_.Exception.Message)"
    }
  }

  if ($script:aivisRunProcessId -gt 0) {
    Write-Output "Stopping AivisSpeech process with PID $script:aivisRunProcessId."
    Stop-StartedProcess -RootProcessId $script:aivisRunProcessId
  }

  if ($null -ne $script:aivisProcess) {
    try {
      $script:aivisProcess.Refresh()
      if (-not $script:aivisProcess.HasExited) {
        Write-Output "Stopping AivisSpeech PowerShell window with PID $($script:aivisProcess.Id)."
        Stop-StartedProcess -RootProcessId $script:aivisProcess.Id
      }
    }
    catch {
      Write-Warning "Could not stop the AivisSpeech PowerShell window. $($_.Exception.Message)"
    }
  }

  Remove-PidFile -Path $script:aivisPidFile
  Remove-PidFile -Path $script:sttPidFile
  Remove-PidFile -Path $script:frontendPidFile
}

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$packageFile = Join-Path $resolvedWorktree 'package.json'
$localEnvironmentFile = Join-Path $resolvedWorktree '.env.local'
$exhibitionEnvironmentFile = Join-Path $resolvedWorktree '.env.exhibition.local'
$aivisScriptFile = Join-Path $resolvedWorktree 'scripts\Start-VayriaAivisSpeech.ps1'
$watcherScriptFile = Join-Path $resolvedWorktree 'scripts\Watch-VayriaExhibition.ps1'
$sttDirectory = Join-Path $resolvedWorktree 'tools\stt'
$sttProjectFile = Join-Path $sttDirectory 'pyproject.toml'
$cudaRuntimePath = Join-Path $env:USERPROFILE '.vayria\cuda12'

Assert-RequiredFile -Path $packageFile -Description 'Vayria package.json'
Assert-RequiredFile -Path $localEnvironmentFile -Description 'Vayria local environment file'
Assert-RequiredFile -Path $exhibitionEnvironmentFile -Description 'Vayria exhibition environment file'
Assert-RequiredFile -Path $aivisScriptFile -Description 'Vayria AivisSpeech launcher'
Assert-RequiredFile -Path $watcherScriptFile -Description 'Vayria exhibition cleanup watcher'
Assert-RequiredFile -Path $sttProjectFile -Description 'Vayria STT project file'

if ($SttDevice -eq 'cuda' -or $SttFallbackDevice -eq 'cuda') {
  if (-not (Test-Path -LiteralPath $cudaRuntimePath -PathType Container)) {
    throw "Vayria CUDA runtime was not found: $cudaRuntimePath"
  }

  # Keep the CUDA DLL lookup scoped to the exhibition launcher and its child
  # processes instead of adding third-party DLLs to the persistent user PATH.
  $env:Path = $cudaRuntimePath + ';' + $env:Path
}

$pwshCommand = Resolve-RequiredCommand -Name 'pwsh.exe'
$uvCommand = Resolve-RequiredCommand -Name 'uv.exe'
$npmCommand = Resolve-RequiredCommand -Name 'npm.cmd'

if ($SttWindow) {
  if ([string]::IsNullOrWhiteSpace($SttPidFile)) {
    throw 'SttPidFile is required for the internal STT window.'
  }
  if (-not [IO.Path]::IsPathRooted($SttPidFile)) {
    throw 'SttPidFile must be an absolute path.'
  }

  $resolvedSttPidFile = [IO.Path]::GetFullPath($SttPidFile)
  $sttExitCode = 1
  $uvProcess = $null
  try {
    try {
      $Host.UI.RawUI.WindowTitle = 'Vayria STT'
    }
    catch {
      # A non-interactive host may not expose a writable window title.
    }

    $sttArguments = @(
      '-m'
      'vayria_stt.server'
      '--host'
      $sttHost
      '--port'
      $sttPort
      '--model'
      $SttModel
      '--device'
      $SttDevice
      '--compute-type'
      $SttComputeType
      '--hotwords'
      $sttHotwordsArgument
      '--require-primary-profile'
      '--fallback-model'
      $SttFallbackModel
      '--fallback-device'
      $SttFallbackDevice
      '--fallback-compute-type'
      $SttFallbackComputeType
    )
    $uvArguments = @(
      'run'
      '--no-cache'
      'python'
    ) + $sttArguments
    $uvProcess = Start-Process `
      -FilePath $uvCommand `
      -WorkingDirectory $sttDirectory `
      -ArgumentList $uvArguments `
      -NoNewWindow `
      -PassThru
    Set-Content -LiteralPath $resolvedSttPidFile -Value $uvProcess.Id -Encoding ascii
    $uvProcess.WaitForExit()
    $sttExitCode = $uvProcess.ExitCode
  }
  catch {
    Write-Error $_
    $sttExitCode = 1
  }
  finally {
    if ($null -ne $uvProcess) {
      $uvProcess.Refresh()
      if (-not $uvProcess.HasExited) {
        Stop-StartedPython -ProcessId $uvProcess.Id
      }
    }
    Remove-PidFile -Path $resolvedSttPidFile
  }

  exit $sttExitCode
}

$action = "start AivisSpeech on $aivisHost`:$aivisPort, uv STT on $sttHost`:$sttPort, and run npm run dev:exhibition"
$exitCode = 1
$aivisProcess = $null
$aivisRunProcessId = 0
$aivisPidFile = Join-Path ([IO.Path]::GetTempPath()) "vayria-aivis-$([guid]::NewGuid().ToString('N')).pid"
$sttProcess = $null
$sttProcessId = 0
$sttPidFile = Join-Path ([IO.Path]::GetTempPath()) "vayria-stt-$([guid]::NewGuid().ToString('N')).pid"
$frontendPidFile = Join-Path ([IO.Path]::GetTempPath()) "vayria-frontend-$([guid]::NewGuid().ToString('N')).pid"
$watcherProcess = $null
$frontendProcess = $null
$cleanupStarted = $false
$launcherMutex = [Threading.Mutex]::new($false, $launcherMutexName)
$mutexAcquired = $false

try {
  if (-not $PSCmdlet.ShouldProcess($resolvedWorktree, $action)) {
    Write-Output "WhatIf: $action in $resolvedWorktree"
    $exitCode = 0
  }
  else {
    try {
      $mutexAcquired = $launcherMutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
      $mutexAcquired = $true
    }

    if (-not $mutexAcquired) {
      throw 'Another Vayria exhibition launcher is already running.'
    }

    if (Test-AivisReady) {
      Write-Output "Reusing healthy AivisSpeech Engine at $aivisBaseUrl (zonoko is available)."
    }
    elseif (Test-ListeningPort -HostName $aivisHost -Port $aivisPort) {
      throw "AivisSpeech port $aivisPort is already in use, but zonoko is not available at $aivisBaseUrl/speakers. Stop the conflicting process before starting exhibition."
    }
    else {
      $aivisArguments = @(
        '-NoProfile'
        '-NoExit'
        '-File'
        $aivisScriptFile
        '-AivisWindow'
        '-PidFile'
        $aivisPidFile
      )

      Write-Output "Starting AivisSpeech in a separate PowerShell window on $aivisHost`:$aivisPort."
      $aivisProcess = Start-Process `
        -FilePath $pwshCommand `
        -WorkingDirectory (Split-Path -Parent $aivisScriptFile) `
        -ArgumentList $aivisArguments `
        -WindowStyle Normal `
        -PassThru

      $aivisRunProcessId = Wait-ForPidFile `
        -Path $aivisPidFile `
        -Process $aivisProcess `
        -TimeoutSeconds 5 `
        -Description 'AivisSpeech PowerShell window'

      Wait-ForAivisReady -Process $aivisProcess
      Write-Output 'AivisSpeech Engine is ready with zonoko.'
    }

    if (Test-ListeningPort -HostName $sttHost -Port $sttPort) {
      throw "Port $sttPort is already in use. Stop the existing process before starting exhibition."
    }

    $scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
    $sttArguments = @(
      '-NoProfile'
      '-NoExit'
      '-File'
      $scriptPath
      '-WorktreePath'
      $resolvedWorktree
      '-SttWindow'
      '-SttPidFile'
      $sttPidFile
      '-SttModel'
      $SttModel
      '-SttDevice'
      $SttDevice
      '-SttComputeType'
      $SttComputeType
      '-SttHotwords'
      $sttHotwordsArgument
      '-SttFallbackModel'
      $SttFallbackModel
      '-SttFallbackDevice'
      $SttFallbackDevice
      '-SttFallbackComputeType'
      $SttFallbackComputeType
    )

    Write-Output "Starting Python STT with uv in a separate PowerShell window on $sttHost`:$sttPort."
    $sttProcess = Start-Process `
      -FilePath $pwshCommand `
      -WorkingDirectory $sttDirectory `
      -ArgumentList $sttArguments `
      -WindowStyle Normal `
      -PassThru

    $sttProcessId = Wait-ForPidFile `
      -Path $sttPidFile `
      -Process $sttProcess `
      -TimeoutSeconds 5 `
      -Description 'Python STT PowerShell window'

    Wait-ForListeningPort `
      -Port $sttPort `
      -Process $sttProcess `
      -TimeoutSeconds $sttStartupTimeoutSeconds `
      -HostName $sttHost

    Write-Output 'Python STT is ready through uv.'
    $watcherArguments = @(
      '-NoProfile'
      '-File'
      $watcherScriptFile
      '-ParentProcessId'
      $PID
      '-FrontendPidFile'
      $frontendPidFile
      '-AivisProcessId'
      $aivisRunProcessId
      '-AivisWindowProcessId'
      $(if ($null -ne $aivisProcess) { $aivisProcess.Id } else { 0 })
      '-SttProcessId'
      $sttProcessId
      '-SttWindowProcessId'
      $sttProcess.Id
      '-AivisPidFile'
      $aivisPidFile
      '-SttPidFile'
      $sttPidFile
    )
    $watcherProcess = Start-Process `
      -FilePath $pwshCommand `
      -WorkingDirectory (Split-Path -Parent $watcherScriptFile) `
      -ArgumentList $watcherArguments `
      -WindowStyle Hidden `
      -PassThru

    Write-Output 'Starting exhibition frontend in the current PowerShell window.'
    $frontendProcess = Start-Process `
      -FilePath $npmCommand `
      -WorkingDirectory $resolvedWorktree `
      -ArgumentList @('run', 'dev:exhibition') `
      -NoNewWindow `
      -PassThru
    Set-Content -LiteralPath $frontendPidFile -Value $frontendProcess.Id -Encoding ascii
    $frontendProcess.WaitForExit()
    $exitCode = $frontendProcess.ExitCode
  }
}
catch {
  Write-Error $_
  $exitCode = 1
}
finally {
  Stop-LauncherChildren

  if ($mutexAcquired) {
    $launcherMutex.ReleaseMutex()
  }
  $launcherMutex.Dispose()
}

exit $exitCode
