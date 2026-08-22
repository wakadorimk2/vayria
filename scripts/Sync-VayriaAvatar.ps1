[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [string]$AvatarSourcePath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.vayria\avatar\model.vrm'),

  [switch]$AllWorktrees,

  [switch]$Force,

  [switch]$AllowMissingSource,

  [switch]$AllowMismatchedTarget
)

$ErrorActionPreference = 'Stop'

function Resolve-WorktreeRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $gitCommand = (Get-Command git.exe -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
  $rootOutput = & $gitCommand '-C' $resolvedPath 'rev-parse' '--show-toplevel'
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "WorktreePath must be inside a Git worktree: $resolvedPath"
  }

  $rootText = ($rootOutput | Select-Object -First 1).ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($rootText)) {
    throw 'Git did not return a worktree root.'
  }

  return (Resolve-Path -LiteralPath $rootText -ErrorAction Stop).Path
}

function Get-WorktreePaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $gitCommand = (Get-Command git.exe -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
  $worktreeOutput = & $gitCommand '-C' $RepositoryRoot 'worktree' 'list' '--porcelain'
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

function Get-FileHashValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}

function Test-ReparsePoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Ensure-AvatarDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorktreeRoot
  )

  $publicDirectory = Join-Path $WorktreeRoot 'public'
  $avatarDirectory = Join-Path $publicDirectory 'avatar'

  if (Test-Path -LiteralPath $publicDirectory) {
    if (-not (Test-Path -LiteralPath $publicDirectory -PathType Container)) {
      throw "The worktree public path is not a directory: $publicDirectory"
    }
    if (Test-ReparsePoint -Path $publicDirectory) {
      throw "The worktree public path must not be a symbolic link or junction: $publicDirectory"
    }
  }
  else {
    New-Item -ItemType Directory -Path $publicDirectory -Force | Out-Null
  }

  if (Test-Path -LiteralPath $avatarDirectory) {
    if (-not (Test-Path -LiteralPath $avatarDirectory -PathType Container)) {
      throw "The worktree avatar path is not a directory: $avatarDirectory"
    }
    if (Test-ReparsePoint -Path $avatarDirectory) {
      throw "The worktree avatar path must not be a symbolic link or junction: $avatarDirectory"
    }
  }
  else {
    New-Item -ItemType Directory -Path $avatarDirectory -Force | Out-Null
  }

  return $avatarDirectory
}

function Copy-VerifiedAvatar {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath,

    [Parameter(Mandatory = $true)]
    [string]$SourceHash
  )

  $targetDirectory = [IO.Path]::GetDirectoryName($TargetPath)
  $temporaryPath = Join-Path $targetDirectory ('.model.vrm.sync-' + [Guid]::NewGuid().ToString('N') + '.tmp')

  if (-not $PSCmdlet.ShouldProcess($TargetPath, "Copy VRM from $SourcePath")) {
    return
  }

  try {
    Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -Force -ErrorAction Stop
    $temporaryHash = Get-FileHashValue -Path $temporaryPath
    if ($temporaryHash -ne $SourceHash) {
      throw "The temporary VRM copy failed hash verification: $temporaryPath"
    }

    Move-Item -LiteralPath $temporaryPath -Destination $TargetPath -Force -ErrorAction Stop
    $targetHash = Get-FileHashValue -Path $TargetPath
    if ($targetHash -ne $SourceHash) {
      throw "The VRM target failed hash verification: $TargetPath"
    }
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Sync-AvatarForWorktree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorktreeRoot,

    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$SourceHash
  )

  $avatarDirectory = Ensure-AvatarDirectory -WorktreeRoot $WorktreeRoot
  $targetPath = Join-Path $avatarDirectory 'model.vrm'

  if (Test-Path -LiteralPath $targetPath) {
    if (Test-ReparsePoint -Path $targetPath) {
      throw "The VRM target must not be a symbolic link or junction: $targetPath"
    }

    $targetHash = Get-FileHashValue -Path $targetPath
    if ($targetHash -eq $SourceHash) {
      Write-Output "Vayria VRM is current: $targetPath"
      return
    }

    if (-not $Force) {
      $message = "Vayria VRM differs from the source. Existing file was preserved: $targetPath"
      if ($AllowMismatchedTarget) {
        Write-Warning $message
        return
      }
      throw "$message Use -Force with Sync-VayriaAvatar.ps1 after inspecting the target."
    }
  }

  Copy-VerifiedAvatar -SourcePath $SourcePath -TargetPath $targetPath -SourceHash $SourceHash
  Write-Output "Synchronized Vayria VRM: $targetPath"
}

$repositoryRoot = Resolve-WorktreeRoot -Path $WorktreePath
$sourcePath = [IO.Path]::GetFullPath($AvatarSourcePath)

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  $message = "Vayria VRM source was not found: $sourcePath"
  if ($AllowMissingSource) {
    Write-Warning "$message Setup will continue without a VRM."
    return
  }
  throw $message
}

if (Test-ReparsePoint -Path $sourcePath) {
  throw "The Vayria VRM source must not be a symbolic link or junction: $sourcePath"
}

$sourceHash = Get-FileHashValue -Path $sourcePath
$worktreePaths = if ($AllWorktrees) {
  Get-WorktreePaths -RepositoryRoot $repositoryRoot
}
else {
  @($repositoryRoot)
}

Write-Output "Vayria VRM source: $sourcePath"
Write-Output "Vayria VRM SHA-256: $sourceHash"

foreach ($worktree in $worktreePaths) {
  Sync-AvatarForWorktree `
    -WorktreeRoot $worktree `
    -SourcePath $sourcePath `
    -SourceHash $sourceHash
}
