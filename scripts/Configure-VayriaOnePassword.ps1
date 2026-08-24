[CmdletBinding()]
param(
  [string]$ReferenceFile = (Join-Path $env:USERPROFILE '.vayria\vayria-op.env'),

  [string]$Vault,

  [string]$Item,

  [string]$Field
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-OpCommand {
  $configuredOp = Join-Path $env:USERPROFILE '.vayria\tools\op.exe'
  if (Test-Path -LiteralPath $configuredOp -PathType Leaf) {
    return $configuredOp
  }

  $command = Get-Command 'op.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $command) {
    return $command.Source
  }

  throw '1Password CLI (op.exe) was not found.'
}

function Invoke-OpJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $json = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "1Password CLI command failed: op $($Arguments -join ' ')"
  }

  return ($json -join [Environment]::NewLine) | ConvertFrom-Json
}

if (-not [IO.Path]::IsPathRooted($ReferenceFile)) {
  throw 'ReferenceFile must be an absolute path.'
}

$resolvedReferenceFile = [IO.Path]::GetFullPath($ReferenceFile)
$referenceDirectory = Split-Path -Parent $resolvedReferenceFile
$opCommand = Resolve-OpCommand

try {
  & $opCommand whoami *> $null
}
catch {
  throw '1Password is not signed in. Run `op signin` after enabling desktop app integration, then run this script again.'
}

if ($LASTEXITCODE -ne 0) {
  throw '1Password is not signed in. Run `op signin` after enabling desktop app integration, then run this script again.'
}

$items = Invoke-OpJson -Command $opCommand -Arguments @('item', 'list', '--format', 'json')
if (@($items).Count -gt 0) {
  Write-Output 'Available 1Password items (metadata only; secret values are not read):'
  @($items) |
    Select-Object id, title, category, @{Name = 'vault'; Expression = { $_.vault.name }} |
    Format-Table -AutoSize |
    Out-String |
    Write-Output
}

if ([string]::IsNullOrWhiteSpace($Vault)) {
  $Vault = Read-Host 'Vault name or ID containing the OpenAI key'
}
if ([string]::IsNullOrWhiteSpace($Item)) {
  $Item = Read-Host 'Item name or ID containing the OpenAI key'
}
if ([string]::IsNullOrWhiteSpace($Field)) {
  $Field = Read-Host 'Field name or ID containing the OpenAI key (for example, credential)'
}

foreach ($part in @(@{Name = 'Vault'; Value = $Vault }, @{Name = 'Item'; Value = $Item }, @{Name = 'Field'; Value = $Field })) {
  if ([string]::IsNullOrWhiteSpace($part.Value) -or $part.Value.Contains("`r") -or $part.Value.Contains("`n") -or $part.Value.Contains('/')) {
    throw "$($part.Name) must be a non-empty 1Password reference component without slashes or newlines."
  }
}

$secretReference = "op://$Vault/$Item/$Field"
$content = @(
  "OPENAI_API_KEY=$secretReference"
) -join [Environment]::NewLine

New-Item -ItemType Directory -Path $referenceDirectory -Force | Out-Null
Set-Content -LiteralPath $resolvedReferenceFile -Value ($content + [Environment]::NewLine) -Encoding utf8NoBOM
Write-Output "Saved 1Password reference to $resolvedReferenceFile"
Write-Output 'The file contains only the op:// reference; use a Vayria :op command to inject the secret at process launch.'
