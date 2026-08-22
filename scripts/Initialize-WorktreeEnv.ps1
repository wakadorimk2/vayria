[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$WorktreePath,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$SecretFile = (Join-Path $env:USERPROFILE '.vayria\secrets.env'),

  [string]$AivisBaseUrl = 'http://127.0.0.1:10101',

  [ValidateSet('local', 'exhibition', 'public')]
  [string]$AppMode = 'local',

  [switch]$Force
)

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$envPath = Join-Path $resolvedWorktree '.env.local'

if (-not [IO.Path]::IsPathRooted($SecretFile)) {
  throw 'SecretFile must be an absolute path.'
}

$resolvedSecretFile = [IO.Path]::GetFullPath($SecretFile)

if (-not (Test-Path -LiteralPath $resolvedSecretFile -PathType Leaf)) {
  throw "The external secret file does not exist: $resolvedSecretFile"
}

if ((Test-Path -LiteralPath $envPath) -and -not $Force) {
  throw "The target .env.local already exists. Use -Force only after inspecting it: $envPath"
}

$lines = @(
  '# This file contains no API key. The key is read from VAYRIA_SECRET_FILE.'
  'OPENAI_API_KEY='
  "VAYRIA_SECRET_FILE=$resolvedSecretFile"
  "AIVIS_BASE_URL=$AivisBaseUrl"
  'AIVIS_SPEED_SCALE=1.15'
  'AIVIS_PITCH_SCALE=0'
  'AIVIS_INTONATION_SCALE=1.0'
  'AIVIS_TEMPO_DYNAMICS_SCALE=1.0'
  'VAYRIA_BIND_HOST=127.0.0.1'
  "VAYRIA_PORT=$Port"
  "VITE_APP_MODE=$AppMode"
  'VITE_API_BASE_URL=/'
)

if ($PSCmdlet.ShouldProcess($envPath, 'Create worktree .env.local without an API key')) {
  Set-Content -LiteralPath $envPath -Value $lines -Encoding utf8
  Write-Output "Created $envPath"
  Write-Output "Referenced external secret file $resolvedSecretFile"
  Write-Output "Configured Vayria port $Port"
}
