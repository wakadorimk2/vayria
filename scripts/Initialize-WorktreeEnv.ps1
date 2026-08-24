[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$WorktreePath,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$HttpsConfigFile = (Join-Path $env:USERPROFILE '.vayria\https.env'),

  [string]$AivisBaseUrl = 'http://127.0.0.1:10101',

  [ValidateSet('local', 'exhibition', 'public')]
  [string]$AppMode = 'local',

  [switch]$Force
)

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$envPath = Join-Path $resolvedWorktree '.env.local'

$resolvedHttpsConfigFile = ''
if (-not [string]::IsNullOrWhiteSpace($HttpsConfigFile)) {
  if (-not [IO.Path]::IsPathRooted($HttpsConfigFile)) {
    throw 'HttpsConfigFile must be an absolute path.'
  }

  $candidateHttpsConfigFile = [IO.Path]::GetFullPath($HttpsConfigFile)
  if (Test-Path -LiteralPath $candidateHttpsConfigFile -PathType Leaf) {
    $resolvedHttpsConfigFile = $candidateHttpsConfigFile
  }
}

if ((Test-Path -LiteralPath $envPath) -and -not $Force) {
  throw "The target .env.local already exists. Use -Force only after inspecting it: $envPath"
}

$lines = @(
  '# API keys are injected by the Vayria :op launch commands.'
  "VAYRIA_HTTPS_CONFIG_FILE=$resolvedHttpsConfigFile"
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
  if ($resolvedHttpsConfigFile) {
    Write-Output "Referenced shared HTTPS config file $resolvedHttpsConfigFile"
  }
  Write-Output "Configured Vayria port $Port"
}
