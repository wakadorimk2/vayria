[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [switch]$SttWindow,

  [string]$SttPidFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sttHost = '127.0.0.1'
$sttPort = 8787
$sttStartupTimeoutSeconds = 30
$launcherMutexName = 'Vayria.ExhibitionLauncher'

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
    [int]$Port
  )

  try {
    return [bool](Test-NetConnection `
        -ComputerName $sttHost `
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
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Python STT process exited before port $Port became available."
    }

    if (Test-ListeningPort -Port $Port) {
      return
    }

    Start-Sleep -Milliseconds 250
  }

  throw "Python STT did not start listening on port $Port within $TimeoutSeconds seconds."
}

function Stop-StartedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId
  )

  try {
    Stop-Process -Id $RootProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-Warning "Could not stop the started PowerShell process with PID $RootProcessId. $($_.Exception.Message)"
  }
}

function Wait-ForPidFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw 'Python STT PowerShell window exited before it recorded the Python process ID.'
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

  throw "Python STT PowerShell window did not record a process ID within $TimeoutSeconds seconds."
}

function Stop-StartedPython {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-Warning "Could not stop the started Python STT process with PID $ProcessId. $($_.Exception.Message)"
  }
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

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$packageFile = Join-Path $resolvedWorktree 'package.json'
$localEnvironmentFile = Join-Path $resolvedWorktree '.env.local'
$exhibitionEnvironmentFile = Join-Path $resolvedWorktree '.env.exhibition.local'
$sttDirectory = Join-Path $resolvedWorktree 'tools\stt'
$sttProjectFile = Join-Path $sttDirectory 'pyproject.toml'
$sttPythonFile = Join-Path $sttDirectory '.venv\Scripts\python.exe'

Assert-RequiredFile -Path $packageFile -Description 'Vayria package.json'
Assert-RequiredFile -Path $localEnvironmentFile -Description 'Vayria local environment file'
Assert-RequiredFile -Path $exhibitionEnvironmentFile -Description 'Vayria exhibition environment file'
Assert-RequiredFile -Path $sttProjectFile -Description 'Vayria STT project file'
Assert-RequiredFile -Path $sttPythonFile -Description 'Vayria STT Python environment'

$pwshCommand = Resolve-RequiredCommand -Name 'pwsh.exe'
$null = Resolve-RequiredCommand -Name 'uv.exe'
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
  $pythonProcess = $null
  try {
    try {
      $Host.UI.RawUI.WindowTitle = 'Vayria STT'
    }
    catch {
      # A non-interactive host may not expose a writable window title.
    }

    $pythonArguments = @(
      '-m'
      'vayria_stt.server'
      '--host'
      $sttHost
      '--port'
      $sttPort
    )
    $pythonProcess = Start-Process `
      -FilePath $sttPythonFile `
      -WorkingDirectory $sttDirectory `
      -ArgumentList $pythonArguments `
      -NoNewWindow `
      -PassThru
    Set-Content -LiteralPath $resolvedSttPidFile -Value $pythonProcess.Id -Encoding ascii
    $pythonProcess.WaitForExit()
    $sttExitCode = $pythonProcess.ExitCode
  }
  catch {
    Write-Error $_
    $sttExitCode = 1
  }
  finally {
    if ($null -ne $pythonProcess) {
      $pythonProcess.Refresh()
      if (-not $pythonProcess.HasExited) {
        Stop-StartedPython -ProcessId $pythonProcess.Id
      }
    }
    Remove-PidFile -Path $resolvedSttPidFile
  }

  exit $sttExitCode
}

$action = "start Python STT on $sttHost`:$sttPort and run npm run dev:exhibition"
$exitCode = 1
$sttProcess = $null
$sttPythonProcessId = 0
$sttPidFile = Join-Path ([IO.Path]::GetTempPath()) "vayria-stt-$([guid]::NewGuid().ToString('N')).pid"
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

    if (Test-ListeningPort -Port $sttPort) {
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
    )

    Write-Output "Starting Python STT in a separate PowerShell window on $sttHost`:$sttPort."
    $sttProcess = Start-Process `
      -FilePath $pwshCommand `
      -WorkingDirectory $sttDirectory `
      -ArgumentList $sttArguments `
      -WindowStyle Normal `
      -PassThru

    $sttPythonProcessId = Wait-ForPidFile `
      -Path $sttPidFile `
      -Process $sttProcess `
      -TimeoutSeconds 5

    Wait-ForListeningPort `
      -Port $sttPort `
      -Process $sttProcess `
      -TimeoutSeconds $sttStartupTimeoutSeconds

    Write-Output 'Python STT is ready.'
    Write-Output 'Starting exhibition frontend in the current PowerShell window.'
    & $npmCommand run dev:exhibition
    $exitCode = $LASTEXITCODE
  }
}
catch {
  Write-Error $_
  $exitCode = 1
}
finally {
  if ($sttPythonProcessId -gt 0) {
    Write-Output "Stopping Python STT process with PID $sttPythonProcessId."
    Stop-StartedPython -ProcessId $sttPythonProcessId
  }

  if ($null -ne $sttProcess) {
    $sttProcess.Refresh()
    if (-not $sttProcess.HasExited) {
      Write-Output "Stopping Python STT PowerShell window with PID $($sttProcess.Id)."
      Stop-StartedProcess -RootProcessId $sttProcess.Id
    }
  }

  Remove-PidFile -Path $sttPidFile

  if ($mutexAcquired) {
    $launcherMutex.ReleaseMutex()
  }
  $launcherMutex.Dispose()
}

exit $exitCode
