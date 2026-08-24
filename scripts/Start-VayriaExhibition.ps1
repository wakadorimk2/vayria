[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [string]$AivisInstallPath = '',

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

  [ValidateSet('Auto', 'WindowsTerminal', 'PowerShellWindow')]
  [string]$TerminalMode = 'Auto',

  [string]$LogDirectory = '',

  # Internal entry point used by Start-VayriaExhibitionTab.ps1.
  [switch]$SttWindow,

  [string]$SttPidFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sttHost = '127.0.0.1'
$sttPort = 8787
$sttStartupTimeoutSeconds = 60
$aivisHost = '127.0.0.1'
$aivisPort = 10101
$aivisBaseUrl = "http://$aivisHost`:$aivisPort"
$aivisStartupTimeoutSeconds = 60
$viteStartupTimeoutSeconds = 30
$launcherMutexName = 'Vayria.ExhibitionLauncher'

function Resolve-RequiredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  if ($null -eq $command) {
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

function Resolve-RequiredDirectory {
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

function Get-EnvironmentFileValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }

  $pattern = '^\s*(?:export\s+)?' + [Regex]::Escape($Name) + '\s*=\s*(.*?)\s*$'
  $match = Select-String -LiteralPath $Path -Pattern $pattern -Encoding utf8 |
    Select-Object -First 1
  if ($null -eq $match) {
    return $null
  }

  $value = $match.Matches[0].Groups[1].Value.Trim()
  if ($value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
       ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  $commentIndex = $value.IndexOf(' #', [StringComparison]::Ordinal)
  if ($commentIndex -ge 0) {
    $value = $value.Substring(0, $commentIndex).Trim()
  }

  return $value
}

function Get-EffectiveEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$LocalEnvironmentFile,

    [Parameter(Mandatory = $true)]
    [string]$ExhibitionEnvironmentFile
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }

  $exhibitionValue = Get-EnvironmentFileValue `
    -Path $ExhibitionEnvironmentFile `
    -Name $Name
  if ($null -ne $exhibitionValue) {
    return $exhibitionValue
  }

  return Get-EnvironmentFileValue -Path $LocalEnvironmentFile -Name $Name
}

function Test-TruthyValue {
  param(
    [string]$Value
  )

  return @('1', 'true', 'yes', 'on') -contains ($Value ?? '').Trim().ToLowerInvariant()
}

function Test-ListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [string]$HostName = '127.0.0.1'
  )

  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connectTask = $client.ConnectAsync($HostName, $Port)
    if (-not $connectTask.Wait(250)) {
      return $false
    }
    return $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

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
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredInstallPath)) {
    $installPaths = @($ConfiguredInstallPath)
  }
  elseif (-not [string]::IsNullOrWhiteSpace($EnvironmentInstallPath)) {
    $installPaths = @($EnvironmentInstallPath)
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
  throw "AivisSpeech Engine was not found. Checked candidates:`n$candidateText"
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
    [int]$ProcessId
  )

  if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return $false
  }

  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  return -not [string]::IsNullOrWhiteSpace($commandLine) -and
    $commandLine.Contains($script:sessionId, [StringComparison]::OrdinalIgnoreCase)
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0 -or -not (Test-SessionProcess -ProcessId $ProcessId)) {
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
      Write-ControllerMessage "[WARN][Cleanup] taskkill.exe exit code $taskkillExitCode for PID $ProcessId."
    }
    return
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-ControllerMessage "[WARN][Cleanup] Could not stop PID $ProcessId. $($_.Exception.Message)"
  }
}

function Read-RoleRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug
  )

  $path = Join-Path $script:sessionDirectory "$RoleSlug.tab.pid.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }

  try {
    $record = Get-Content -Raw -LiteralPath $path -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    if ($record.sessionId -ne $script:sessionId) {
      return $null
    }
    return $record
  }
  catch {
    return $null
  }
}

function Read-RoleStatus {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug
  )

  $path = Join-Path $script:sessionDirectory "$RoleSlug.status.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }

  try {
    $status = Get-Content -Raw -LiteralPath $path -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    if ($status.sessionId -ne $script:sessionId) {
      return $null
    }
    return $status
  }
  catch {
    return $null
  }
}

function Assert-RoleAlive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug
  )

  $status = Read-RoleStatus -RoleSlug $RoleSlug
  if ($null -ne $status -and $status.state -in @('failed', 'exited', 'stopped')) {
    throw "$RoleSlug tab stopped with exit code $($status.exitCode). $($status.message)"
  }

  $record = Read-RoleRecord -RoleSlug $RoleSlug
  if ($null -eq $record) {
    throw "$RoleSlug tab did not record its process ID."
  }
  if (-not (Test-ProcessAlive -ProcessId ([int]$record.processId))) {
    throw "$RoleSlug tab process $($record.processId) is not running."
  }
}

function Wait-ForRoleProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug,

    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = Read-RoleStatus -RoleSlug $RoleSlug
    if ($null -ne $status -and $status.state -in @('failed', 'exited', 'stopped')) {
      throw "$RoleSlug tab failed before readiness. $($status.message)"
    }

    $record = Read-RoleRecord -RoleSlug $RoleSlug
    if ($null -ne $record -and (Test-ProcessAlive -ProcessId ([int]$record.processId))) {
      return
    }

    Start-Sleep -Milliseconds 250
  }

  throw "$RoleSlug tab did not record a running process within $TimeoutSeconds seconds."
}

function Wait-ForAivisReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug
  )

  $deadline = (Get-Date).AddSeconds($aivisStartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-AivisReady) {
      return
    }
    Assert-RoleAlive -RoleSlug $RoleSlug
    Start-Sleep -Milliseconds 250
  }

  throw "AivisSpeech did not expose zonoko at $aivisBaseUrl/speakers within $aivisStartupTimeoutSeconds seconds."
}

function Wait-ForListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleSlug,

    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds,

    [string]$HostName = '127.0.0.1',

    [string]$Description = 'service'
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort -HostName $HostName -Port $Port) {
      return
    }
    Assert-RoleAlive -RoleSlug $RoleSlug
    Start-Sleep -Milliseconds 250
  }

  throw "$HostName`:$Port did not become ready within $TimeoutSeconds seconds."
}

function Test-ViteReady {
  $scheme = if ($script:effectiveHttps) { 'https' } else { 'http' }
  $uri = "$($scheme)://127.0.0.1`:$($script:effectiveVitePort)/"
  $requestParameters = @{
    Uri         = $uri
    TimeoutSec  = 2
    ErrorAction = 'Stop'
  }
  if ($script:effectiveHttps) {
    $requestParameters.SkipCertificateCheck = $true
  }

  try {
    $response = Invoke-WebRequest @requestParameters
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Wait-ForViteReady {
  $deadline = (Get-Date).AddSeconds($viteStartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ViteReady) {
      return
    }
    Assert-RoleAlive -RoleSlug 'vite'
    Start-Sleep -Milliseconds 250
  }

  throw "Vite did not serve the exhibition page on port $($script:effectiveVitePort) within $viteStartupTimeoutSeconds seconds."
}

function Write-ControllerMessage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not [string]::IsNullOrWhiteSpace($script:controllerLogPath)) {
    Add-Content -LiteralPath $script:controllerLogPath `
      -Value "$(Get-Date -Format o) $Message" `
      -Encoding utf8
  }
  Write-Output $Message
}

function Write-StageStart {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  Write-ControllerMessage "[START][$Stage] $Message"
}

function Write-StageOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  Write-ControllerMessage "[OK][$Stage] $Message"
}

function Write-StageFail {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  Write-ControllerMessage "[FAIL] $Stage"
  Write-ControllerMessage "Reason: $Message"

  $roleSlug = switch ($Stage) {
    'AivisSpeech' { 'aivisspeech' }
    'STT' { 'stt' }
    'Vite' { 'vite' }
    default { '' }
  }
  if (-not [string]::IsNullOrWhiteSpace($roleSlug) -and
      -not [string]::IsNullOrWhiteSpace($script:resolvedLogDirectory)) {
    Write-ControllerMessage "stdout: $(Join-Path $script:resolvedLogDirectory "$roleSlug.stdout.log")"
    Write-ControllerMessage "stderr: $(Join-Path $script:resolvedLogDirectory "$roleSlug.stderr.log")"
  }
  Write-ControllerMessage 'Action: inspect the logs, then press Ctrl+C in the control tab.'
}

function Test-SecretConfiguration {
  $processApiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY')
  if ([string]::IsNullOrWhiteSpace($processApiKey)) {
    throw 'No OpenAI API key is available in the process environment. Use npm run exhibition:start:op after configuring 1Password.'
  }

  if ($processApiKey.Trim().StartsWith('op://', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OPENAI_API_KEY is an unresolved 1Password reference. Use npm run exhibition:start:op.'
  }
}

function Test-HttpsConfiguration {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LocalEnvironmentFile,

    [Parameter(Mandatory = $true)]
    [string]$ExhibitionEnvironmentFile
  )

  $httpsEnabled = Test-TruthyValue (Get-EffectiveEnvironmentValue `
      -Name 'VAYRIA_HTTPS' `
      -LocalEnvironmentFile $LocalEnvironmentFile `
      -ExhibitionEnvironmentFile $ExhibitionEnvironmentFile)
  $script:effectiveHttps = $httpsEnabled
  if (-not $httpsEnabled) {
    return
  }

  $configFile = Get-EffectiveEnvironmentValue `
    -Name 'VAYRIA_HTTPS_CONFIG_FILE' `
    -LocalEnvironmentFile $LocalEnvironmentFile `
    -ExhibitionEnvironmentFile $ExhibitionEnvironmentFile
  $certificateFile = Get-EffectiveEnvironmentValue `
    -Name 'VAYRIA_HTTPS_CERT_FILE' `
    -LocalEnvironmentFile $LocalEnvironmentFile `
    -ExhibitionEnvironmentFile $ExhibitionEnvironmentFile
  $privateKeyFile = Get-EffectiveEnvironmentValue `
    -Name 'VAYRIA_HTTPS_KEY_FILE' `
    -LocalEnvironmentFile $LocalEnvironmentFile `
    -ExhibitionEnvironmentFile $ExhibitionEnvironmentFile

  if (-not [string]::IsNullOrWhiteSpace($configFile)) {
    if (-not [IO.Path]::IsPathRooted($configFile)) {
      throw 'VAYRIA_HTTPS_CONFIG_FILE must be an absolute path.'
    }
    $resolvedConfigFile = [IO.Path]::GetFullPath($configFile)
    if (-not (Test-Path -LiteralPath $resolvedConfigFile -PathType Leaf)) {
      throw "VAYRIA_HTTPS_CONFIG_FILE was not found: $resolvedConfigFile"
    }
    $certificateFile = Get-EnvironmentFileValue -Path $resolvedConfigFile -Name 'VAYRIA_HTTPS_CERT_FILE'
    $privateKeyFile = Get-EnvironmentFileValue -Path $resolvedConfigFile -Name 'VAYRIA_HTTPS_KEY_FILE'
  }

  if ([string]::IsNullOrWhiteSpace($certificateFile) -or
      [string]::IsNullOrWhiteSpace($privateKeyFile)) {
    throw 'HTTPS requires VAYRIA_HTTPS_CERT_FILE and VAYRIA_HTTPS_KEY_FILE.'
  }
  if (-not (Test-Path -LiteralPath $certificateFile -PathType Leaf)) {
    throw "HTTPS certificate was not found: $certificateFile"
  }
  if (-not (Test-Path -LiteralPath $privateKeyFile -PathType Leaf)) {
    throw "HTTPS private key was not found: $privateKeyFile"
  }
}

function Test-Preflight {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ResolvedWorktree
  )

  $packageFile = Join-Path $ResolvedWorktree 'package.json'
  $localEnvironmentFile = Join-Path $ResolvedWorktree '.env.local'
  $exhibitionEnvironmentFile = Join-Path $ResolvedWorktree '.env.exhibition.local'
  $aivisScriptFile = Join-Path $ResolvedWorktree 'scripts\Start-VayriaAivisSpeech.ps1'
  $watcherScriptFile = Join-Path $ResolvedWorktree 'scripts\Watch-VayriaExhibition.ps1'
  $tabScriptFile = Join-Path $ResolvedWorktree 'scripts\Start-VayriaExhibitionTab.ps1'
  $sttDirectory = Join-Path $ResolvedWorktree 'tools\stt'
  $sttProjectFile = Join-Path $sttDirectory 'pyproject.toml'
  $sttLockFile = Join-Path $sttDirectory 'uv.lock'
  $vitePackageDirectory = Join-Path $ResolvedWorktree 'node_modules\vite'

  Assert-RequiredFile -Path $packageFile -Description 'Vayria package.json'
  Assert-RequiredFile -Path $localEnvironmentFile -Description 'Vayria local environment file'
  Assert-RequiredFile -Path $exhibitionEnvironmentFile -Description 'Vayria exhibition environment file'
  Assert-RequiredFile -Path $aivisScriptFile -Description 'Vayria AivisSpeech launcher'
  Assert-RequiredFile -Path $watcherScriptFile -Description 'Vayria exhibition cleanup watcher'
  Assert-RequiredFile -Path $tabScriptFile -Description 'Vayria exhibition tab launcher'
  Assert-RequiredFile -Path $sttProjectFile -Description 'Vayria STT project file'
  Assert-RequiredFile -Path $sttLockFile -Description 'Vayria STT lock file'
  if (-not (Test-Path -LiteralPath $vitePackageDirectory -PathType Container)) {
    throw "Vite dependency was not found: $vitePackageDirectory"
  }

  $script:resolvedCommands = @{}
  foreach ($commandName in @('pwsh.exe', 'node.exe', 'npm.cmd', 'uv.exe')) {
    $script:resolvedCommands[$commandName] = Resolve-RequiredCommand -Name $commandName
  }

  $script:effectiveVitePort = 5187
  $rawPort = Get-EffectiveEnvironmentValue `
    -Name 'VAYRIA_PORT' `
    -LocalEnvironmentFile $localEnvironmentFile `
    -ExhibitionEnvironmentFile $exhibitionEnvironmentFile
  if (-not [string]::IsNullOrWhiteSpace($rawPort)) {
    $parsedPort = 0
    if (-not [int]::TryParse($rawPort, [ref]$parsedPort) -or
        $parsedPort -lt 1 -or $parsedPort -gt 65535) {
      throw "VAYRIA_PORT must be an integer from 1 to 65535: $rawPort"
    }
    $script:effectiveVitePort = $parsedPort
  }

  $appMode = Get-EffectiveEnvironmentValue `
    -Name 'VITE_APP_MODE' `
    -LocalEnvironmentFile $localEnvironmentFile `
    -ExhibitionEnvironmentFile $exhibitionEnvironmentFile
  if ($appMode -ne 'exhibition') {
    throw "VITE_APP_MODE must be exhibition: $appMode"
  }

  Test-SecretConfiguration
  Test-HttpsConfiguration `
    -LocalEnvironmentFile $localEnvironmentFile `
    -ExhibitionEnvironmentFile $exhibitionEnvironmentFile

  $cudaRuntimePath = Join-Path $env:USERPROFILE '.vayria\cuda12'
  if ($SttDevice -eq 'cuda' -or $SttFallbackDevice -eq 'cuda') {
    if (-not (Test-Path -LiteralPath $cudaRuntimePath -PathType Container)) {
      throw "Vayria CUDA runtime was not found: $cudaRuntimePath"
    }
    $env:Path = $cudaRuntimePath + ';' + $env:Path
  }

  $uvCheckArguments = @(
    'run'
    '--no-sync'
    '--no-cache'
    'python'
    '-c'
    'import faster_whisper, websockets, webrtcvad; print("stt-dependencies-ok")'
  )
  Push-Location -LiteralPath $sttDirectory
  try {
    $uvCheckOutput = & $script:resolvedCommands['uv.exe'] @uvCheckArguments 2>&1 |
      Out-String
    $uvCheckExitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($uvCheckExitCode -ne 0) {
    throw "STT dependency check failed with exit code $uvCheckExitCode. $($uvCheckOutput.Trim())"
  }

  $script:aivisAlreadyReady = Test-AivisReady
  if (-not $script:aivisAlreadyReady) {
    if (Test-ListeningPort -HostName $aivisHost -Port $aivisPort) {
      throw "AivisSpeech port $aivisPort is already in use, but zonoko is not available at $aivisBaseUrl/speakers."
    }
    Resolve-AivisEnginePath `
      -ConfiguredInstallPath $AivisInstallPath `
      -EnvironmentInstallPath $env:VAYRIA_AIVIS_INSTALL_PATH | Out-Null
  }

  if (Test-ListeningPort -HostName $sttHost -Port $sttPort) {
    throw "STT port $sttPort is already in use. Stop the existing process before starting exhibition."
  }
  if (Test-ListeningPort -HostName '127.0.0.1' -Port $script:effectiveVitePort) {
    throw "Vite port $script:effectiveVitePort is already in use. Stop the existing process before starting exhibition."
  }

  $wtCommand = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($TerminalMode -eq 'WindowsTerminal' -and $null -eq $wtCommand) {
    throw 'Windows Terminal was requested, but wt.exe was not found.'
  }
  if ($TerminalMode -eq 'Auto' -and $null -ne $wtCommand) {
    $script:resolvedTerminalMode = 'WindowsTerminal'
    $script:resolvedCommands['wt.exe'] = $wtCommand.Source
  }
  elseif ($TerminalMode -eq 'WindowsTerminal') {
    $script:resolvedTerminalMode = 'WindowsTerminal'
    $script:resolvedCommands['wt.exe'] = $wtCommand.Source
  }
  else {
    $script:resolvedTerminalMode = 'PowerShellWindow'
  }
}

function Get-RoleSlug {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Role
  )

  switch ($Role) {
    'AivisSpeech' { return 'aivisspeech' }
    'Stt' { return 'stt' }
    'Vite' { return 'vite' }
    default { throw "Unknown exhibition role: $Role" }
  }
}

function Get-RoleTitle {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Role
  )

  switch ($Role) {
    'AivisSpeech' { return 'AivisSpeech' }
    'Stt' { return 'STT' }
    'Vite' { return 'Vite' }
    default { throw "Unknown exhibition role: $Role" }
  }
}

function Get-TabWorkingDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Role
  )

  if ($Role -eq 'Stt') {
    return Join-Path $script:resolvedWorktree 'tools\stt'
  }
  return $script:resolvedWorktree
}

function Get-TabArguments {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Role,

    [string]$StartAfterFile
  )

  $tabScriptFile = Join-Path $script:resolvedWorktree 'scripts\Start-VayriaExhibitionTab.ps1'
  $arguments = @(
    '-NoProfile'
    '-NoExit'
    '-File'
    $tabScriptFile
    '-Role'
    $Role
    '-WorktreePath'
    $script:resolvedWorktree
    '-SessionId'
    $script:sessionId
    '-SessionDirectory'
    $script:sessionDirectory
    '-LogDirectory'
    $script:resolvedLogDirectory
    '-SttModel'
    $SttModel
    '-SttDevice'
    $SttDevice
    '-SttComputeType'
    $SttComputeType
    '-SttHotwords'
    $SttHotwords
    '-SttFallbackModel'
    $SttFallbackModel
    '-SttFallbackDevice'
    $SttFallbackDevice
    '-SttFallbackComputeType'
    $SttFallbackComputeType
  )
  if (-not [string]::IsNullOrWhiteSpace($AivisInstallPath)) {
    $arguments += @('-AivisInstallPath', $AivisInstallPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($StartAfterFile)) {
    $arguments += @('-StartAfterFile', $StartAfterFile)
  }
  return $arguments
}

function Start-ExhibitionTabs {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Roles
  )

  $tabSpecs = @()
  foreach ($role in $Roles) {
    $gateFile = switch ($role) {
      'AivisSpeech' { '' }
      'Stt' { $script:aivisReadyGateFile }
      'Vite' { $script:sttReadyGateFile }
    }
    $tabSpecs += [pscustomobject]@{
      Role              = $role
      Title             = Get-RoleTitle -Role $role
      WorkingDirectory  = Get-TabWorkingDirectory -Role $role
      Arguments         = Get-TabArguments -Role $role -StartAfterFile $gateFile
    }
  }

  if ($script:resolvedTerminalMode -eq 'WindowsTerminal') {
    $wtArguments = @()
    $isFirst = $true
    foreach ($spec in $tabSpecs) {
      if (-not $isFirst) {
        $wtArguments += ';'
      }
      $wtArguments += @(
        'new-tab'
        '--title'
        "Vayria - $($spec.Title)"
        '--suppressApplicationTitle'
        '--startingDirectory'
        $spec.WorkingDirectory
        $script:resolvedCommands['pwsh.exe']
      )
      $wtArguments += $spec.Arguments
      $isFirst = $false
    }

    try {
      & $script:resolvedCommands['wt.exe'] @wtArguments
      $wtExitCode = $LASTEXITCODE
      if ($wtExitCode -ne 0) {
        throw "wt.exe failed with exit code $wtExitCode."
      }
      return
    }
    catch {
      if ($TerminalMode -ne 'Auto') {
        throw
      }
      $script:resolvedTerminalMode = 'PowerShellWindow'
      Write-ControllerMessage "[WARN][Runtime] Windows Terminal could not be started. Falling back to PowerShell windows. $($_.Exception.Message)"
    }
  }

  foreach ($spec in $tabSpecs) {
    $quotedArguments = @($spec.Arguments | ForEach-Object {
        $argument = [string]$_
        if ($argument.Contains('"')) {
          $argument = $argument.Replace('"', '\"')
        }
        if ($argument -match '\s') {
          return '"' + $argument + '"'
        }
        return $argument
      })
    $windowProcess = Start-Process `
      -FilePath $script:resolvedCommands['pwsh.exe'] `
      -WorkingDirectory $spec.WorkingDirectory `
      -ArgumentList $quotedArguments `
      -WindowStyle Normal `
      -PassThru
    $script:fallbackWindowProcesses += $windowProcess
  }
}

function Start-CleanupWatcher {
  $watcherScriptFile = Join-Path $script:resolvedWorktree 'scripts\Watch-VayriaExhibition.ps1'
  $watcherArguments = @(
    '-NoProfile'
    '-File'
    $watcherScriptFile
    '-ParentProcessId'
    "$PID"
    '-SessionDirectory'
    $script:sessionDirectory
    '-SessionId'
    $script:sessionId
  )

  $quotedWatcherArguments = @($watcherArguments | ForEach-Object {
      $argument = [string]$_
      if ($argument.Contains('"')) {
        $argument = $argument.Replace('"', '\"')
      }
      if ($argument -match '\s') {
        return '"' + $argument + '"'
      }
      return $argument
    })

  $script:watcherProcess = Start-Process `
    -FilePath $script:resolvedCommands['pwsh.exe'] `
    -WorkingDirectory $script:resolvedWorktree `
    -ArgumentList $quotedWatcherArguments `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $script:resolvedLogDirectory 'watcher.stdout.log') `
    -RedirectStandardError (Join-Path $script:resolvedLogDirectory 'watcher.stderr.log') `
    -PassThru
}

function Set-ReadyGate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  Set-Content -LiteralPath $Path -Value (Get-Date -Format o) -Encoding ascii
}

function Stop-SessionProcesses {
  if ($script:cleanupStarted) {
    return
  }
  $script:cleanupStarted = $true

  Write-ControllerMessage '[START][Cleanup] Stopping Vayria exhibition process trees.'
  if (Test-Path -LiteralPath $script:sessionDirectory -PathType Container) {
    foreach ($role in @('aivisspeech', 'stt', 'vite')) {
      $record = Read-RoleRecord -RoleSlug $role
      if ($null -ne $record) {
        $processId = [int]$record.processId
        if (Test-SessionProcess -ProcessId $processId) {
          Write-ControllerMessage "[INFO][Cleanup] Stopping $role root PID $processId."
          Stop-ProcessTree -ProcessId $processId
        }
      }
    }
  }

  foreach ($windowProcess in $script:fallbackWindowProcesses) {
    try {
      $windowProcess.Refresh()
      if (-not $windowProcess.HasExited -and
          (Test-SessionProcess -ProcessId $windowProcess.Id)) {
        Write-ControllerMessage "[INFO][Cleanup] Stopping fallback window root PID $($windowProcess.Id)."
        Stop-ProcessTree -ProcessId $windowProcess.Id
      }
    }
    catch {
      Write-ControllerMessage "[WARN][Cleanup] Could not inspect fallback window PID $($windowProcess.Id). $($_.Exception.Message)"
    }
  }

  if ($null -ne $script:watcherProcess) {
    try {
      $script:watcherProcess.Refresh()
      if (-not $script:watcherProcess.HasExited) {
        Stop-Process -Id $script:watcherProcess.Id -Force -ErrorAction Stop
      }
    }
    catch {
      Write-ControllerMessage "[WARN][Cleanup] Could not stop the cleanup watcher. $($_.Exception.Message)"
    }
  }

  foreach ($path in @(
      $script:aivisReadyGateFile
      $script:sttReadyGateFile
      (Join-Path $script:sessionDirectory 'aivisspeech.tab.pid.json')
      (Join-Path $script:sessionDirectory 'stt.tab.pid.json')
      (Join-Path $script:sessionDirectory 'vite.tab.pid.json')
      (Join-Path $script:sessionDirectory 'aivisspeech.child.pid.json')
      (Join-Path $script:sessionDirectory 'stt.child.pid.json')
    )) {
    if (-not [string]::IsNullOrWhiteSpace($path) -and
        (Test-Path -LiteralPath $path -PathType Leaf)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }

  Write-ControllerMessage '[OK][Cleanup] Cleanup completed.'
}

$resolvedWorktree = Resolve-RequiredDirectory -Path $WorktreePath -Description 'Vayria worktree'
$packageFile = Join-Path $resolvedWorktree 'package.json'
$localEnvironmentFile = Join-Path $resolvedWorktree '.env.local'
$exhibitionEnvironmentFile = Join-Path $resolvedWorktree '.env.exhibition.local'
$sttDirectory = Join-Path $resolvedWorktree 'tools\stt'
$cudaRuntimePath = Join-Path $env:USERPROFILE '.vayria\cuda12'
$script:resolvedWorktree = $resolvedWorktree
$script:controllerLogPath = ''
$script:sessionId = ''
$script:sessionDirectory = ''
$script:resolvedLogDirectory = ''
$script:aivisReadyGateFile = ''
$script:sttReadyGateFile = ''
$script:watcherProcess = $null
$script:fallbackWindowProcesses = @()
$script:cleanupStarted = $false
$script:currentStage = 'Preflight'
$exitCode = 1

if ($SttWindow) {
  $sttProjectFile = Join-Path $sttDirectory 'pyproject.toml'
  Assert-RequiredFile -Path $sttProjectFile -Description 'Vayria STT project file'
  $uvCommand = Resolve-RequiredCommand -Name 'uv.exe'

  if ([string]::IsNullOrWhiteSpace($SttPidFile)) {
    throw 'SttPidFile is required for the internal STT window.'
  }
  if (-not [IO.Path]::IsPathRooted($SttPidFile)) {
    throw 'SttPidFile must be an absolute path.'
  }
  $resolvedSttPidFile = [IO.Path]::GetFullPath($SttPidFile)

  if ($SttDevice -eq 'cuda' -or $SttFallbackDevice -eq 'cuda') {
    if (-not (Test-Path -LiteralPath $cudaRuntimePath -PathType Container)) {
      throw "Vayria CUDA runtime was not found: $cudaRuntimePath"
    }
    $env:Path = $cudaRuntimePath + ';' + $env:Path
  }

  $sttHotwordsArgument = '"' + $SttHotwords.Replace('"', '\"') + '"'
  $sttArguments = @(
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
    $sttHotwordsArgument
    '--require-primary-profile'
    '--fallback-model'
    $SttFallbackModel
    '--fallback-device'
    $SttFallbackDevice
    '--fallback-compute-type'
    $SttFallbackComputeType
  )
  $uvArguments = @('run', '--no-sync', '--no-cache', 'python') + $sttArguments
  $uvProcess = $null
  $sttExitCode = 1
  try {
    try {
      $Host.UI.RawUI.WindowTitle = 'Vayria - STT'
    }
    catch {
      # A non-interactive host may not expose a writable window title.
    }

    $uvProcess = Start-Process `
      -FilePath $uvCommand `
      -WorkingDirectory $sttDirectory `
      -ArgumentList $uvArguments `
      -NoNewWindow `
      -PassThru
    # Keep the legacy STT PID file format for existing manual watcher calls.
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
        try {
          Stop-Process -Id $uvProcess.Id -Force -ErrorAction Stop
        }
        catch {
          Write-Warning "Could not stop the Python STT process. $($_.Exception.Message)"
        }
      }
    }
    if (Test-Path -LiteralPath $resolvedSttPidFile -PathType Leaf) {
      Remove-Item -LiteralPath $resolvedSttPidFile -Force -ErrorAction SilentlyContinue
    }
  }
  exit $sttExitCode
}

try {
  Write-StageStart -Stage 'Preflight' -Message 'Checking commands, files, configuration, dependencies, ports, and runtime mode.'
  Test-Preflight -ResolvedWorktree $resolvedWorktree
  Write-StageOk -Stage 'Preflight' -Message "Preflight passed. Terminal mode: $script:resolvedTerminalMode. Vite port: $script:effectiveVitePort."

  if (-not $PSCmdlet.ShouldProcess($resolvedWorktree, 'start Vayria exhibition runtime')) {
    Write-ControllerMessage "WhatIf: start Vayria exhibition runtime in $resolvedWorktree."
    $exitCode = 0
  }
  else {
    $script:sessionId = [Guid]::NewGuid().ToString('N')
    $script:sessionDirectory = Join-Path ([IO.Path]::GetTempPath()) "vayria-exhibition-$script:sessionId"
    New-Item -ItemType Directory -Path $script:sessionDirectory -Force | Out-Null

    if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
      $runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$($script:sessionId.Substring(0, 8))"
      $script:resolvedLogDirectory = Join-Path `
        $resolvedWorktree `
        (Join-Path 'logs\exhibition' $runId)
    }
    elseif ([IO.Path]::IsPathRooted($LogDirectory)) {
      $script:resolvedLogDirectory = [IO.Path]::GetFullPath($LogDirectory)
    }
    else {
      $script:resolvedLogDirectory = [IO.Path]::GetFullPath((Join-Path $resolvedWorktree $LogDirectory))
    }
    New-Item -ItemType Directory -Path $script:resolvedLogDirectory -Force | Out-Null
    $script:controllerLogPath = Join-Path $script:resolvedLogDirectory 'controller.log'
    $script:aivisReadyGateFile = Join-Path $script:sessionDirectory 'aivisspeech.ready'
    $script:sttReadyGateFile = Join-Path $script:sessionDirectory 'stt.ready'
    foreach ($roleSlug in @('aivisspeech', 'stt', 'vite')) {
      foreach ($stream in @('stdout', 'stderr')) {
        Set-Content `
          -LiteralPath (Join-Path $script:resolvedLogDirectory "$roleSlug.$stream.log") `
          -Value '' `
          -Encoding utf8
      }
    }
    Write-ControllerMessage "[INFO][Runtime] Logs: $script:resolvedLogDirectory"
    Write-ControllerMessage "[INFO][Runtime] Session: $script:sessionId"

    $launcherMutex = [Threading.Mutex]::new($false, $launcherMutexName)
    $mutexAcquired = $false
    try {
      try {
        $mutexAcquired = $launcherMutex.WaitOne(0)
      }
      catch [Threading.AbandonedMutexException] {
        $mutexAcquired = $true
      }
      if (-not $mutexAcquired) {
        throw 'Another Vayria exhibition launcher is already running.'
      }

      $script:currentStage = 'Runtime'
      Write-StageStart -Stage 'Runtime' -Message 'Starting cleanup watcher and exhibition tabs.'
      Start-CleanupWatcher

      $roles = @('Stt', 'Vite')
      if (-not $script:aivisAlreadyReady) {
        $roles = @('AivisSpeech') + $roles
      }
      else {
        Set-ReadyGate -Path $script:aivisReadyGateFile
        Write-ControllerMessage "[OK][AivisSpeech] Reusing healthy AivisSpeech Engine at $aivisBaseUrl."
      }

      Start-ExhibitionTabs -Roles $roles
      foreach ($role in $roles) {
        Wait-ForRoleProcess -RoleSlug (Get-RoleSlug -Role $role)
      }
      Write-StageOk -Stage 'Runtime' -Message 'Exhibition tabs were dispatched.'

      if (-not $script:aivisAlreadyReady) {
        $script:currentStage = 'AivisSpeech'
        Write-StageStart -Stage 'AivisSpeech' -Message 'Waiting for zonoko at 127.0.0.1:10101.'
        Wait-ForAivisReady -RoleSlug 'aivisspeech'
        Set-ReadyGate -Path $script:aivisReadyGateFile
        Write-StageOk -Stage 'AivisSpeech' -Message 'AivisSpeech is ready with zonoko.'
      }

      $script:currentStage = 'STT'
      Write-StageStart -Stage 'STT' -Message 'Waiting for Python STT on 127.0.0.1:8787.'
      Wait-ForListeningPort `
        -RoleSlug 'stt' `
        -Port $sttPort `
        -TimeoutSeconds $sttStartupTimeoutSeconds `
        -HostName $sttHost `
        -Description 'Python STT'
      Set-ReadyGate -Path $script:sttReadyGateFile
      Write-StageOk -Stage 'STT' -Message 'Python STT is listening.'

      $script:currentStage = 'Vite'
      Write-StageStart -Stage 'Vite' -Message "Waiting for exhibition Vite on port $script:effectiveVitePort."
      Wait-ForViteReady
      Write-StageOk -Stage 'Vite' -Message "Vite is serving the exhibition page on port $script:effectiveVitePort."

      $script:currentStage = 'Running'
      Write-StageOk -Stage 'Running' -Message 'Vayria exhibition is running. Press Ctrl+C in this control tab to stop owned processes.'
      Write-ControllerMessage "[INFO][Running] A service tab Ctrl+C stops that service only."
      Write-ControllerMessage "[INFO][Running] Logs: $script:resolvedLogDirectory"

      $lastStates = @{}
      while ($true) {
        foreach ($role in @('aivisspeech', 'stt', 'vite')) {
          $status = Read-RoleStatus -RoleSlug $role
          if ($null -eq $status) {
            continue
          }
          $state = [string]$status.state
          if (-not $lastStates.ContainsKey($role) -or $lastStates[$role] -ne $state) {
            $lastStates[$role] = $state
            Write-ControllerMessage "[INFO][Running] $role state: $state."
          }
        }
        Start-Sleep -Seconds 1
      }
    }
    finally {
      if ($mutexAcquired) {
        $launcherMutex.ReleaseMutex()
      }
      $launcherMutex.Dispose()
    }
  }
}
catch {
  $failureMessage = $_.Exception.Message
  Write-StageFail -Stage $script:currentStage -Message $failureMessage
  if (-not [string]::IsNullOrWhiteSpace($script:resolvedLogDirectory)) {
    Write-ControllerMessage "[INFO][$script:currentStage] Logs: $script:resolvedLogDirectory"
  }
  $exitCode = 1
}
finally {
  if (-not [string]::IsNullOrWhiteSpace($script:sessionDirectory)) {
    Stop-SessionProcesses
  }
}

exit $exitCode
