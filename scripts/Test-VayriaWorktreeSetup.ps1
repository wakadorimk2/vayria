[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupScript = Join-Path $scriptDirectory 'Setup-VayriaWorktree.ps1'
$syncScript = Join-Path $scriptDirectory 'Sync-VayriaAvatar.ps1'
$pwshCommand = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1).Source
$gitCommand = (Get-Command git.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "vayria-worktree-setup-$([Guid]::NewGuid().ToString('N'))"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)

if (-not $resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The test directory is outside the system temporary directory.'
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & $Command @Arguments > $null
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Native command failed with exit code ${exitCode}: $Command"
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

function Invoke-SetupScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [Parameter(Mandatory = $true)]
    [string]$ExternalSecretFile,

    [string]$ExternalHttpsConfigFile,

    [Parameter(Mandatory = $true)]
    [string]$AvatarSourcePath,

    [switch]$ExpectFailure,

    [switch]$UseCurrentDirectory
  )

  $arguments = @(
    '-NoProfile'
    '-File'
    $setupScript
    '-WorktreePath'
    $Worktree
    '-SecretFile'
    $ExternalSecretFile
    '-AvatarSourcePath'
    $AvatarSourcePath
  )

  if (-not [string]::IsNullOrWhiteSpace($ExternalHttpsConfigFile)) {
    $arguments += @(
      '-HttpsConfigFile'
      $ExternalHttpsConfigFile
    )
  }

  if ($ExpectFailure) {
    & $pwshCommand @arguments *> $null
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      throw "Setup unexpectedly succeeded for $Worktree"
    }

    return
  }

  if ($UseCurrentDirectory) {
    Push-Location -LiteralPath $Worktree
    try {
      & $pwshCommand @arguments
    }
    finally {
      Pop-Location
    }
  }
  else {
    & $pwshCommand @arguments
  }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Setup failed with exit code $exitCode for $Worktree"
  }
}

function Invoke-AvatarSyncScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [Parameter(Mandatory = $true)]
    [string]$AvatarSourcePath,

    [switch]$AllWorktrees,

    [switch]$Force,

    [switch]$ExpectFailure
  )

  $arguments = @(
    '-NoProfile'
    '-File'
    $syncScript
    '-WorktreePath'
    $Worktree
    '-AvatarSourcePath'
    $AvatarSourcePath
  )

  if ($AllWorktrees) {
    $arguments += '-AllWorktrees'
  }
  if ($Force) {
    $arguments += '-Force'
  }

  if ($ExpectFailure) {
    & $pwshCommand @arguments *> $null
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      throw "Avatar sync unexpectedly succeeded for $Worktree"
    }
    return
  }

  & $pwshCommand @arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Avatar sync failed with exit code $exitCode for $Worktree"
  }
}

function New-TestPortReservation {
  param(
    [int]$StartPort = 5190,

    [int]$EndPort = 5999
  )

  for ($candidatePort = $StartPort; $candidatePort -le $EndPort; $candidatePort++) {
    $candidateListener = [Net.Sockets.TcpListener]::new(
      [Net.IPAddress]::Loopback,
      $candidatePort
    )
    try {
      $candidateListener.Start()
      return [PSCustomObject]@{
        Listener = $candidateListener
        Port     = $candidatePort
      }
    }
    catch {
      $candidateListener.Dispose()
    }
  }

  throw "No free test port exists in the range $StartPort-$EndPort."
}

$repositoryRoot = Join-Path $testRoot 'repo'
$worktreeOne = Join-Path $testRoot 'worktree-one'
$worktreeTwo = Join-Path $testRoot 'worktree-two'
$worktreeThree = Join-Path $testRoot 'worktree-three'
$worktreeFour = Join-Path $testRoot 'worktree-four'
$worktreeFive = Join-Path $testRoot 'worktree-five'
$worktreeSix = Join-Path $testRoot 'worktree-six'
$secretDirectory = Join-Path $testRoot 'secret folder'
$secretFile = Join-Path $secretDirectory 'secrets.env'
$httpsConfigFile = Join-Path $secretDirectory 'https.env'
$avatarSourceDirectory = Join-Path $testRoot 'avatar source folder'
$avatarSourceFile = Join-Path $avatarSourceDirectory 'model.vrm'
$repositoryAvatar = Join-Path $repositoryRoot 'public\avatar\model.vrm'
$worktreeOneAvatar = Join-Path $worktreeOne 'public\avatar\model.vrm'
$worktreeTwoAvatar = Join-Path $worktreeTwo 'public\avatar\model.vrm'
$worktreeThreeAvatar = Join-Path $worktreeThree 'public\avatar\model.vrm'
$worktreeFourAvatar = Join-Path $worktreeFour 'public\avatar\model.vrm'
$worktreeFiveAvatar = Join-Path $worktreeFive 'public\avatar\model.vrm'
$worktreeSixAvatar = Join-Path $worktreeSix 'public\avatar\model.vrm'
$worktreeOneEnv = Join-Path $worktreeOne '.env.local'
$worktreeTwoEnv = Join-Path $worktreeTwo '.env.local'
$worktreeThreeEnv = Join-Path $worktreeThree '.env.local'
$worktreeFourEnv = Join-Path $worktreeFour '.env.local'
$worktreeFiveEnv = Join-Path $worktreeFive '.env.local'
$worktreeSixEnv = Join-Path $worktreeSix '.env.local'

try {
  New-Item -ItemType Directory -Path $repositoryRoot, $secretDirectory, $avatarSourceDirectory -Force | Out-Null
  Set-Content -LiteralPath $secretFile -Value 'OPENAI_API_KEY=test-worktree-key' -Encoding utf8
  Set-Content -LiteralPath $httpsConfigFile -Value @(
    'VAYRIA_HTTPS=true'
    'VAYRIA_HTTPS_CERT_FILE=C:\shared\vayria-cert.pem'
    'VAYRIA_HTTPS_KEY_FILE=C:\shared\vayria-key.pem'
  ) -Encoding utf8
  Set-Content -LiteralPath $avatarSourceFile -Value 'test-vrm-payload' -Encoding utf8

  Invoke-NativeChecked -Command $gitCommand -Arguments @('init', '--quiet', $repositoryRoot)
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'config', 'user.email', 'test@example.invalid')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'config', 'user.name', 'Vayria Setup Test')
  Set-Content -LiteralPath (Join-Path $repositoryRoot 'README.md') -Value '# Setup test' -Encoding utf8
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'add', '--', 'README.md')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'commit', '--quiet', '-m', 'setup test')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeOne, 'HEAD')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeTwo, 'HEAD')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeThree, 'HEAD')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeFour, 'HEAD')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeFive, 'HEAD')
  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'add', '--quiet', '--detach', $worktreeSix, 'HEAD')

  Invoke-SetupScript -Worktree $worktreeOne -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $avatarSourceFile -UseCurrentDirectory
  Invoke-SetupScript -Worktree $worktreeTwo -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $avatarSourceFile

  $portOne = [int](Get-EnvironmentValue -Path $worktreeOneEnv -Name 'VAYRIA_PORT')
  $portTwo = [int](Get-EnvironmentValue -Path $worktreeTwoEnv -Name 'VAYRIA_PORT')
  if ($portOne -lt 5188 -or $portOne -gt 5210) {
    throw "The first allocated port is outside the worker range: $portOne"
  }
  if ($portTwo -lt 5188 -or $portTwo -gt 5210 -or $portTwo -eq $portOne) {
    throw "The second allocated port is invalid or duplicated: $portTwo"
  }

  $exhibitionCases = @(
    @{
      EnvPath = Join-Path $worktreeOne '.env.exhibition.local'
      Port    = $portOne
    }
    @{
      EnvPath = Join-Path $worktreeTwo '.env.exhibition.local'
      Port    = $portTwo
    }
  )
  foreach ($case in $exhibitionCases) {
    if (-not (Test-Path -LiteralPath $case.EnvPath -PathType Leaf)) {
      throw "The generated exhibition environment is missing: $($case.EnvPath)"
    }
    if ((Get-EnvironmentValue -Path $case.EnvPath -Name 'VITE_APP_MODE') -ne 'exhibition') {
      throw "The generated exhibition environment has an unexpected mode: $($case.EnvPath)"
    }
    if ((Get-EnvironmentValue -Path $case.EnvPath -Name 'VAYRIA_BIND_HOST') -ne '0.0.0.0') {
      throw "The generated exhibition environment has an unexpected bind host: $($case.EnvPath)"
    }
    if ([int](Get-EnvironmentValue -Path $case.EnvPath -Name 'VAYRIA_PORT') -ne $case.Port) {
      throw "The generated exhibition environment has an unexpected port: $($case.EnvPath)"
    }
  }

  $avatarHash = (Get-FileHash -LiteralPath $avatarSourceFile -Algorithm SHA256).Hash
  foreach ($avatarPath in @($worktreeOneAvatar, $worktreeTwoAvatar)) {
    if (-not (Test-Path -LiteralPath $avatarPath -PathType Leaf)) {
      throw "Setup did not copy the VRM: $avatarPath"
    }
    if ((Get-FileHash -LiteralPath $avatarPath -Algorithm SHA256).Hash -ne $avatarHash) {
      throw "The copied VRM has an unexpected hash: $avatarPath"
    }
  }

  foreach ($envPath in @($worktreeOneEnv, $worktreeTwoEnv)) {
    if ((Get-EnvironmentValue -Path $envPath -Name 'OPENAI_API_KEY') -ne '') {
      throw "The generated environment contains a non-empty OPENAI_API_KEY: $envPath"
    }

    $secretReference = Get-EnvironmentValue -Path $envPath -Name 'VAYRIA_SECRET_FILE'
    if (-not [string]::Equals($secretReference, [IO.Path]::GetFullPath($secretFile), [StringComparison]::OrdinalIgnoreCase)) {
      throw "The generated environment has an unexpected secret file reference: $envPath"
    }

    $httpsConfigReference = Get-EnvironmentValue -Path $envPath -Name 'VAYRIA_HTTPS_CONFIG_FILE'
    if (-not [string]::Equals($httpsConfigReference, [IO.Path]::GetFullPath($httpsConfigFile), [StringComparison]::OrdinalIgnoreCase)) {
      throw "The generated environment has an unexpected HTTPS config file reference: $envPath"
    }
  }

  $hashBeforeRerun = (Get-FileHash -LiteralPath $worktreeOneEnv -Algorithm SHA256).Hash
  $avatarHashBeforeRerun = (Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash
  Invoke-SetupScript -Worktree $worktreeOne -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $avatarSourceFile
  $hashAfterRerun = (Get-FileHash -LiteralPath $worktreeOneEnv -Algorithm SHA256).Hash
  if ($hashBeforeRerun -ne $hashAfterRerun) {
    throw 'Setup changed an existing .env.local.'
  }
  if ((Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash -ne $avatarHashBeforeRerun) {
    throw 'Setup changed an already synchronized VRM.'
  }

  $missingAvatarSource = Join-Path $avatarSourceDirectory 'missing.vrm'
  $worktreeTwoEnvironmentHash = (Get-FileHash -LiteralPath $worktreeTwoEnv -Algorithm SHA256).Hash
  Remove-Item -LiteralPath $worktreeTwoAvatar -Force
  Invoke-SetupScript -Worktree $worktreeTwo -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $missingAvatarSource
  if ((Get-FileHash -LiteralPath $worktreeTwoEnv -Algorithm SHA256).Hash -ne $worktreeTwoEnvironmentHash) {
    throw 'Setup changed an existing .env.local when the VRM source was missing.'
  }
  if (Test-Path -LiteralPath $worktreeTwoAvatar) {
    throw 'Setup created a VRM when the source was missing.'
  }
  Invoke-AvatarSyncScript -Worktree $worktreeTwo -AvatarSourcePath $avatarSourceFile

  Set-Content -LiteralPath $worktreeOneAvatar -Value 'local-worktree-vrm' -Encoding utf8
  $protectedAvatarHash = (Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash
  Invoke-SetupScript -Worktree $worktreeOne -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $avatarSourceFile
  if ((Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash -ne $protectedAvatarHash) {
    throw 'Setup overwrote a differing VRM without explicit synchronization.'
  }
  Invoke-AvatarSyncScript -Worktree $worktreeOne -AvatarSourcePath $avatarSourceFile -ExpectFailure
  if ((Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash -ne $protectedAvatarHash) {
    throw 'A failed explicit synchronization changed the differing VRM.'
  }
  Invoke-AvatarSyncScript -Worktree $worktreeOne -AvatarSourcePath $avatarSourceFile -Force
  if ((Get-FileHash -LiteralPath $worktreeOneAvatar -Algorithm SHA256).Hash -ne $avatarHash) {
    throw 'Force synchronization did not update the differing VRM.'
  }

  $listener = $null
  $listenerPort = $null
  try {
    $reservation = New-TestPortReservation
    $listener = $reservation.Listener
    $listenerPort = $reservation.Port

    Invoke-SetupScript -Worktree $worktreeThree -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $httpsConfigFile -AvatarSourcePath $avatarSourceFile
    $portThree = [int](Get-EnvironmentValue -Path $worktreeThreeEnv -Name 'VAYRIA_PORT')
    if ($portThree -le $listenerPort) {
      throw "The setup did not skip the TCP-used port ${listenerPort}: $portThree"
    }
  }
  finally {
    if ($null -ne $listener) {
      $listener.Stop()
      $listener.Dispose()
    }
  }

  $parallelCases = @(
    @{
      Worktree = $worktreeFive
      EnvPath  = $worktreeFiveEnv
      Stdout   = Join-Path $testRoot 'worktree-five.out.log'
      Stderr   = Join-Path $testRoot 'worktree-five.err.log'
    }
    @{
      Worktree = $worktreeSix
      EnvPath  = $worktreeSixEnv
      Stdout   = Join-Path $testRoot 'worktree-six.out.log'
      Stderr   = Join-Path $testRoot 'worktree-six.err.log'
    }
  )
  $parallelProcesses = foreach ($case in $parallelCases) {
    $processArguments = @(
      '-NoProfile'
      '-File'
      ('"{0}"' -f $setupScript)
      '-WorktreePath'
      ('"{0}"' -f $case.Worktree)
      '-SecretFile'
      ('"{0}"' -f $secretFile)
      '-HttpsConfigFile'
      ('"{0}"' -f $httpsConfigFile)
      '-AvatarSourcePath'
      ('"{0}"' -f $avatarSourceFile)
    )

    Start-Process `
      -FilePath $pwshCommand `
      -ArgumentList $processArguments `
      -WindowStyle Hidden `
      -RedirectStandardOutput $case.Stdout `
      -RedirectStandardError $case.Stderr `
      -PassThru
  }

  foreach ($process in $parallelProcesses) {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "Concurrent setup failed with exit code $($process.ExitCode)."
    }
  }

  $parallelPortOne = [int](Get-EnvironmentValue -Path $worktreeFiveEnv -Name 'VAYRIA_PORT')
  $parallelPortTwo = [int](Get-EnvironmentValue -Path $worktreeSixEnv -Name 'VAYRIA_PORT')
  if ($parallelPortOne -eq $parallelPortTwo) {
    throw "Concurrent setup allocated the same port: $parallelPortOne"
  }

  foreach ($envPath in @($worktreeThreeEnv, $worktreeFiveEnv, $worktreeSixEnv)) {
    if ((Get-EnvironmentValue -Path $envPath -Name 'OPENAI_API_KEY') -ne '') {
      throw "The generated environment contains a non-empty OPENAI_API_KEY: $envPath"
    }

    $secretReference = Get-EnvironmentValue -Path $envPath -Name 'VAYRIA_SECRET_FILE'
    if (-not [string]::Equals($secretReference, [IO.Path]::GetFullPath($secretFile), [StringComparison]::OrdinalIgnoreCase)) {
      throw "The generated environment has an unexpected secret file reference: $envPath"
    }

    $httpsConfigReference = Get-EnvironmentValue -Path $envPath -Name 'VAYRIA_HTTPS_CONFIG_FILE'
    if (-not [string]::Equals($httpsConfigReference, [IO.Path]::GetFullPath($httpsConfigFile), [StringComparison]::OrdinalIgnoreCase)) {
      throw "The generated environment has an unexpected HTTPS config file reference: $envPath"
    }
  }

  Invoke-AvatarSyncScript -Worktree $repositoryRoot -AvatarSourcePath $avatarSourceFile -AllWorktrees -Force
  foreach ($avatarPath in @(
      $repositoryAvatar,
      $worktreeOneAvatar,
      $worktreeTwoAvatar,
      $worktreeThreeAvatar,
      $worktreeFourAvatar,
      $worktreeFiveAvatar,
      $worktreeSixAvatar
    )) {
    if (-not (Test-Path -LiteralPath $avatarPath -PathType Leaf)) {
      throw "All-worktree synchronization did not create the VRM: $avatarPath"
    }
    if ((Get-FileHash -LiteralPath $avatarPath -Algorithm SHA256).Hash -ne $avatarHash) {
      throw "All-worktree synchronization produced an unexpected hash: $avatarPath"
    }
  }

  $missingSecretFile = Join-Path $secretDirectory 'missing.env'
  Invoke-SetupScript -Worktree $worktreeFour -ExternalSecretFile $missingSecretFile -AvatarSourcePath $avatarSourceFile -ExpectFailure
  if (Test-Path -LiteralPath $worktreeFourEnv) {
    throw 'Setup created .env.local after the secret file check failed.'
  }

  $missingHttpsConfigFile = Join-Path $secretDirectory 'missing-https.env'
  Invoke-SetupScript -Worktree $worktreeFour -ExternalSecretFile $secretFile -ExternalHttpsConfigFile $missingHttpsConfigFile -AvatarSourcePath $avatarSourceFile
  if (-not [string]::IsNullOrEmpty((Get-EnvironmentValue -Path $worktreeFourEnv -Name 'VAYRIA_HTTPS_CONFIG_FILE'))) {
    throw 'Setup recorded a missing HTTPS config file.'
  }

  Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'remove', '--force', $worktreeOne)
  if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    throw 'The external secret file did not survive worktree deletion.'
  }
  if (-not (Test-Path -LiteralPath $avatarSourceFile -PathType Leaf)) {
    throw 'The avatar source did not survive worktree deletion.'
  }

  Write-Output "Vayria worktree setup tests passed: ports $portOne, $portTwo, $portThree, $parallelPortOne, and $parallelPortTwo."
}
finally {
  foreach ($worktree in @($worktreeOne, $worktreeTwo, $worktreeThree, $worktreeFour, $worktreeFive, $worktreeSix)) {
    if (Test-Path -LiteralPath $worktree -PathType Container) {
      try {
        Invoke-NativeChecked -Command $gitCommand -Arguments @('-C', $repositoryRoot, 'worktree', 'remove', '--force', $worktree)
      }
      catch {
        # The temporary directory cleanup below is still safe if Git cleanup fails.
      }
    }
  }

  if (Test-Path -LiteralPath $resolvedTestRoot) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
