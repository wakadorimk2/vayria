[CmdletBinding()]
param(
  [string]$ReferenceFile = (Join-Path $env:USERPROFILE '.vayria\vayria-op.env'),

  [string]$SecretReference,

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

if ([string]::IsNullOrWhiteSpace($SecretReference)) {
  if ([string]::IsNullOrWhiteSpace($Vault) -and
      [string]::IsNullOrWhiteSpace($Item) -and
      [string]::IsNullOrWhiteSpace($Field)) {
    $SecretReference = Read-Host 'Paste the 1Password secret reference for the OpenAI key (op://vault/item/field)'
  } else {
    if ([string]::IsNullOrWhiteSpace($Vault)) {
      $Vault = Read-Host 'Vault name or ID containing the OpenAI key'
    }
    if ([string]::IsNullOrWhiteSpace($Item)) {
      $Item = Read-Host 'Item name or ID containing the OpenAI key'
    }
    if ([string]::IsNullOrWhiteSpace($Field)) {
      $Field = Read-Host 'Field name or ID containing the OpenAI key (for example, credential)'
    }

    $SecretReference = "op://$Vault/$Item/$Field"
  }
}

$SecretReference = $SecretReference.Trim()
if ($SecretReference.Length -ge 2 -and
    ((($SecretReference.StartsWith('"')) -and ($SecretReference.EndsWith('"'))) -or
     (($SecretReference.StartsWith("'")) -and ($SecretReference.EndsWith("'"))))) {
  $SecretReference = $SecretReference.Substring(1, $SecretReference.Length - 2).Trim()
}

if (-not $SecretReference.StartsWith('op://', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The secret reference must start with op://.'
}

$referenceComponents = $SecretReference.Substring(5).Split('/')
if ($referenceComponents.Count -ne 3) {
  throw 'The secret reference must have the form op://vault/item/field.'
}

foreach ($component in $referenceComponents) {
  if ([string]::IsNullOrWhiteSpace($component) -or $component.Contains("`r") -or $component.Contains("`n")) {
    throw 'The secret reference must contain non-empty vault, item, and field components.'
  }
}

$content = "OPENAI_API_KEY=$SecretReference"

New-Item -ItemType Directory -Path $referenceDirectory -Force | Out-Null
Set-Content -LiteralPath $resolvedReferenceFile -Value ($content + [Environment]::NewLine) -Encoding utf8NoBOM
Write-Output "Saved 1Password reference to $resolvedReferenceFile"
Write-Output 'The file contains only the op:// reference; use a Vayria :op command to inject the secret at process launch.'
