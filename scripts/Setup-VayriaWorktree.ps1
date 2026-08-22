[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [ValidateRange(0, 65535)]
  [int]$Port = 0,

  [string]$SecretFile = (Join-Path $env:USERPROFILE '.vayria\secrets.env'),

  [string]$AvatarSourcePath = (Join-Path $env:USERPROFILE '.vayria\avatar\model.vrm')
)

$ErrorActionPreference = 'Stop'

$worktreePortStart = 5188
$worktreePortEnd = 5210
$portMutexName = 'Vayria.WorktreePortAllocation'
$gitCommand = (Get-Command git.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1).Source
$pwshCommand = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1).Source
$avatarSyncScript = Join-Path $PSScriptRoot 'Sync-VayriaAvatar.ps1'

if ($Port -ne 0 -and ($Port -lt $worktreePortStart -or $Port -gt $worktreePortEnd)) {
  throw "Port must be 0 for automatic allocation or from $worktreePortStart to $worktreePortEnd."
}

function Resolve-WorktreeRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $gitArguments = @('-C', $resolvedPath, 'rev-parse', '--show-toplevel')
  $rootOutput = & $gitCommand @gitArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw 'WorktreePath must be inside a Git worktree.'
  }

  $rootText = ($rootOutput | Select-Object -First 1).ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($rootText)) {
    throw 'Git did not return a worktree root.'
  }

  return (Resolve-Path -LiteralPath $rootText -ErrorAction Stop).Path
}

function Resolve-SecretFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not [IO.Path]::IsPathRooted($Path)) {
    throw 'SecretFile must be an absolute path.'
  }

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
    throw "The external secret file does not exist: $resolvedPath"
  }

  return $resolvedPath
}

function Invoke-AvatarSynchronization {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$SourcePath
  )

  $syncArguments = @(
    '-NoProfile'
    '-File'
    $avatarSyncScript
    '-WorktreePath'
    $RepositoryRoot
    '-AvatarSourcePath'
    $SourcePath
    '-AllowMissingSource'
    '-AllowMismatchedTarget'
  )

  if ($WhatIfPreference) {
    $syncArguments += '-WhatIf'
  }

  & $pwshCommand @syncArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Vayria VRM synchronization failed with exit code ${exitCode}."
  }
}

function Get-EnvironmentValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $pattern = '^\s*' + [Regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
  $match = Select-String -LiteralPath $Path -Pattern $pattern -Encoding utf8 |
    Select-Object -First 1
  if ($null -eq $match) {
    return $null
  }

  return $match.Matches[0].Groups[1].Value.Trim()
}

function Get-ExistingWorktreePort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$EnvPath
  )

  $portValue = Get-EnvironmentValue -Path $EnvPath -Name 'VAYRIA_PORT'
  if ([string]::IsNullOrWhiteSpace($portValue)) {
    throw "Existing .env.local has no VAYRIA_PORT. Setup stopped without overwriting it: $EnvPath"
  }

  try {
    $existingPort = [int]$portValue
  }
  catch {
    throw "Existing .env.local has an invalid VAYRIA_PORT. Setup stopped without overwriting it: $EnvPath"
  }

  if ($existingPort -lt 1 -or $existingPort -gt 65535) {
    throw "Existing .env.local has an invalid VAYRIA_PORT. Setup stopped without overwriting it: $EnvPath"
  }

  $secretReference = Get-EnvironmentValue -Path $EnvPath -Name 'VAYRIA_SECRET_FILE'
  if ([string]::IsNullOrWhiteSpace($secretReference)) {
    throw "Existing .env.local has no VAYRIA_SECRET_FILE. Setup stopped without overwriting it: $EnvPath"
  }

  if (-not [IO.Path]::IsPathRooted($secretReference)) {
    throw "Existing .env.local has a relative VAYRIA_SECRET_FILE. Setup stopped without overwriting it: $EnvPath"
  }

  [void](Resolve-SecretFile -Path $secretReference)

  $legacyKey = Select-String -LiteralPath $EnvPath -Pattern '^\s*OPENAI_API_KEY\s*=\s*\S.*$' -Encoding utf8 |
    Select-Object -First 1
  if ($null -ne $legacyKey) {
    throw "Existing .env.local contains a non-empty OPENAI_API_KEY. Setup stopped without overwriting it: $EnvPath"
  }

  return $existingPort
}

function Get-WorktreePaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $gitArguments = @('-C', $RepositoryRoot, 'worktree', 'list', '--porcelain')
  $worktreeOutput = & $gitCommand @gitArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw 'Git could not list the repository worktrees.'
  }

  $paths = [Collections.Generic.List[string]]::new()
  foreach ($line in $worktreeOutput) {
    if (-not $line.StartsWith('worktree ', [StringComparison]::Ordinal)) {
      continue
    }

    $pathText = $line.Substring('worktree '.Length).Trim()
    if (-not (Test-Path -LiteralPath $pathText -PathType Container)) {
      continue
    }

    $resolvedPath = (Resolve-Path -LiteralPath $pathText -ErrorAction Stop).Path
    if (-not $paths.Contains($resolvedPath)) {
      [void]$paths.Add($resolvedPath)
    }
  }

  return ,$paths
}

function Get-ReservedPorts {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $reservedPorts = [Collections.Generic.HashSet[int]]::new()
  foreach ($path in (Get-WorktreePaths -RepositoryRoot $RepositoryRoot)) {
    $envPath = Join-Path $path '.env.local'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
      continue
    }

    $portValue = Get-EnvironmentValue -Path $envPath -Name 'VAYRIA_PORT'
    if ([string]::IsNullOrWhiteSpace($portValue)) {
      continue
    }

    try {
      $port = [int]$portValue
    }
    catch {
      continue
    }

    if ($port -ge $worktreePortStart -and $port -le $worktreePortEnd) {
      [void]$reservedPorts.Add($port)
    }
  }

  return ,$reservedPorts
}

function Test-TcpPortAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [int]$CandidatePort
  )

  $listener = $null
  try {
    $listener = [Net.Sockets.TcpListener]::new(
      [Net.IPAddress]::Loopback,
      $CandidatePort
    )
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    if ($null -ne $listener) {
      $listener.Stop()
      $listener.Dispose()
    }
  }
}

function Find-AvailableWorktreePort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $reservedPorts = Get-ReservedPorts -RepositoryRoot $RepositoryRoot
  for ($candidate = $worktreePortStart; $candidate -le $worktreePortEnd; $candidate++) {
    if ($reservedPorts.Contains($candidate)) {
      continue
    }

    if (Test-TcpPortAvailable -CandidatePort $candidate) {
      return $candidate
    }
  }

  throw "No available Vayria worktree port exists in the range $worktreePortStart-$worktreePortEnd."
}

function Invoke-WorktreeInitialization {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [int]$SelectedPort,

    [Parameter(Mandatory = $true)]
    [string]$ResolvedSecretFile
  )

  $initializer = Join-Path $PSScriptRoot 'Initialize-WorktreeEnv.ps1'
  $initializerParameters = @{
    WorktreePath = $RepositoryRoot
    Port         = $SelectedPort
    SecretFile   = $ResolvedSecretFile
  }

  if ($WhatIfPreference) {
    $initializerParameters.WhatIf = $true
  }

  & $initializer @initializerParameters
}

function Ensure-ExhibitionEnvironment {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [int]$SelectedPort
  )

  $envPath = Join-Path $RepositoryRoot '.env.exhibition.local'
  $generatedMarker = '# Generated by Setup-VayriaWorktree.ps1.'

  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $existingContent = Get-Content -Raw -LiteralPath $envPath
    if (-not $existingContent.StartsWith($generatedMarker, [StringComparison]::Ordinal)) {
      Write-Output "Existing exhibition environment preserved: $envPath"
      return
    }
  }

  $lines = @(
    $generatedMarker
    '# Do not add secrets here. Shared server settings remain in .env.local.'
    'VITE_APP_MODE=exhibition'
    'VITE_API_BASE_URL=/'
    'VITE_VOICE_INPUT_TRANSPORT=remote'
    'VAYRIA_BIND_HOST=0.0.0.0'
    "VAYRIA_PORT=$SelectedPort"
    'VAYRIA_HTTPS=false'
    'VAYRIA_HTTPS_CERT_FILE='
    'VAYRIA_HTTPS_KEY_FILE='
    'VAYRIA_STT_WS_URL=ws://127.0.0.1:8787/stream'
  )

  if ($PSCmdlet.ShouldProcess($envPath, "Create exhibition environment for port $SelectedPort")) {
    Set-Content -LiteralPath $envPath -Value $lines -Encoding utf8
    Write-Output "Configured exhibition environment $envPath on port $SelectedPort"
  }
}

$repositoryRoot = Resolve-WorktreeRoot -Path $WorktreePath
$envPath = Join-Path $repositoryRoot '.env.local'
$resolvedSecretFile = Resolve-SecretFile -Path $SecretFile
Invoke-AvatarSynchronization -RepositoryRoot $repositoryRoot -SourcePath $AvatarSourcePath
$mutex = [Threading.Mutex]::new($false, $portMutexName)
$lockAcquired = $false

try {
  try {
    $lockAcquired = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
  }
  catch [Threading.AbandonedMutexException] {
    $lockAcquired = $true
  }

  if (-not $lockAcquired) {
    throw 'Could not acquire the Vayria worktree port allocation lock within 30 seconds.'
  }

  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $existingPort = Get-ExistingWorktreePort -EnvPath $envPath
    Ensure-ExhibitionEnvironment `
      -RepositoryRoot $repositoryRoot `
      -SelectedPort $existingPort
    Write-Output "Existing Vayria worktree configuration preserved on port $existingPort."
    return
  }

  $selectedPort = $Port
  if ($selectedPort -eq 0) {
    $selectedPort = Find-AvailableWorktreePort -RepositoryRoot $repositoryRoot
  }
  else {
    $reservedPorts = Get-ReservedPorts -RepositoryRoot $repositoryRoot
    if ($reservedPorts.Contains($selectedPort)) {
      throw "Vayria worktree port $selectedPort is already reserved by another worktree."
    }

    if (-not (Test-TcpPortAvailable -CandidatePort $selectedPort)) {
      throw "Vayria worktree port $selectedPort is already in use."
    }
  }

  Invoke-WorktreeInitialization `
    -RepositoryRoot $repositoryRoot `
    -SelectedPort $selectedPort `
    -ResolvedSecretFile $resolvedSecretFile

  Ensure-ExhibitionEnvironment `
    -RepositoryRoot $repositoryRoot `
    -SelectedPort $selectedPort

  Write-Output "Configured Vayria worktree on port $selectedPort."
}
finally {
  if ($lockAcquired) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
