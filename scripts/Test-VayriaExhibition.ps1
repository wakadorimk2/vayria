[CmdletBinding()]
param(
  [string]$WorktreePath = (Get-Location).Path,

  [switch]$Preflight,

  [switch]$Strict
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath -ErrorAction Stop).Path
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDirectory 'VayriaExhibitionNetwork.ps1')

$settings = [ordered]@{}
$knownEnvironmentNames = @(
  'VITE_APP_MODE'
  'VAYRIA_BIND_HOST'
  'VAYRIA_EXHIBITION_BIND_HOST'
  'VAYRIA_EXHIBITION_HOTSPOT_IP'
  'VAYRIA_EXHIBITION_INTERFACE_ALIAS'
  'VAYRIA_PORT'
  'VAYRIA_HTTPS'
  'VAYRIA_HTTPS_CONFIG_FILE'
  'VAYRIA_HTTPS_CERT_FILE'
  'VAYRIA_HTTPS_KEY_FILE'
  'VAYRIA_MDNS_ENABLED'
  'AIVIS_BASE_URL'
  'VAYRIA_STT_WS_URL'
)
$warnings = 0
$failures = 0

function Import-VayriaEnvironmentFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name = $matches[1]
      $value = $matches[2].Trim()
      if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq "'" -and $last -eq "'") -or ($first -eq '"' -and $last -eq '"')) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      $settings[$name] = $value
    }
  }
}

function Get-VayriaSetting {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }
  if ($settings.Contains($Name)) {
    return ([string]$settings[$Name]).Trim()
  }
  return $null
}

function Add-VayriaCheck {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [ValidateSet('OK', 'WARN', 'FAIL')]
    [string]$Status,

    [Parameter(Mandatory = $true)]
    [string]$Message,

    [string]$Action
  )

  if ($Status -eq 'FAIL') {
    $script:failures++
  }
  elseif ($Status -eq 'WARN') {
    $script:warnings++
    if ($Strict) { $script:failures++ }
  }

  $color = switch ($Status) {
    'OK' { 'Green' }
    'WARN' { 'Yellow' }
    default { 'Red' }
  }
  Write-Host (('[{0}] {1}: {2}' -f $Status, $Name, $Message)) -ForegroundColor $color
  if (-not [string]::IsNullOrWhiteSpace($Action)) {
    Write-Host "  Action: $Action" -ForegroundColor DarkYellow
  }
}

foreach ($fileName in @('.env', '.env.local', '.env.exhibition', '.env.exhibition.local')) {
  Import-VayriaEnvironmentFile -Path (Join-Path $resolvedWorktree $fileName)
}

$externalHttpsConfig = Get-VayriaSetting -Name 'VAYRIA_HTTPS_CONFIG_FILE'
if (-not [string]::IsNullOrWhiteSpace($externalHttpsConfig)) {
  if (-not [IO.Path]::IsPathRooted($externalHttpsConfig)) {
    $externalHttpsConfig = [IO.Path]::GetFullPath((Join-Path $resolvedWorktree $externalHttpsConfig))
  }
  if (Test-Path -LiteralPath $externalHttpsConfig -PathType Leaf) {
    Import-VayriaEnvironmentFile -Path $externalHttpsConfig
  }
  else {
    Add-VayriaCheck `
      -Name 'HTTPS config file' `
      -Status 'FAIL' `
      -Message "Configured file was not found: $externalHttpsConfig" `
      -Action 'Create the shared HTTPS config or clear VAYRIA_HTTPS_CONFIG_FILE.'
  }
}

foreach ($name in $knownEnvironmentNames) {
  $processValue = [Environment]::GetEnvironmentVariable($name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    $settings[$name] = $processValue.Trim()
  }
}

Write-Host 'Vayria Exhibition Check' -ForegroundColor Cyan
Write-Host "Worktree: $resolvedWorktree"
Write-Host "Mode: $([string](Get-VayriaSetting -Name 'VITE_APP_MODE'))"
if ($Preflight) { Write-Host 'Scope: preflight (providers and running health are skipped)' }

$mode = Get-VayriaSetting -Name 'VITE_APP_MODE'
if ($mode -eq 'exhibition') {
  Add-VayriaCheck -Name 'mode' -Status 'OK' -Message 'VITE_APP_MODE=exhibition.'
}
else {
  Add-VayriaCheck `
    -Name 'mode' `
    -Status 'FAIL' `
    -Message 'Exhibition mode is not selected.' `
    -Action 'Set VITE_APP_MODE=exhibition in .env.exhibition.local.'
}

$bindHost = Get-VayriaSetting -Name 'VAYRIA_EXHIBITION_BIND_HOST'
if ([string]::IsNullOrWhiteSpace($bindHost)) {
  $bindHost = Get-VayriaSetting -Name 'VAYRIA_BIND_HOST'
}
if ([string]::IsNullOrWhiteSpace($bindHost)) { $bindHost = '127.0.0.1' }
if ($bindHost -match '^(127\.0\.0\.1|localhost|::1)$') {
  Add-VayriaCheck `
    -Name 'bind' `
    -Status 'FAIL' `
    -Message "The server is loopback-only ($bindHost)." `
    -Action 'Turn on the hotspot and run npm run exhibition so the launcher passes the detected hotspot IP.'
}
elseif ($bindHost -eq '0.0.0.0' -or $bindHost -eq '::') {
  Add-VayriaCheck `
    -Name 'bind' `
    -Status 'WARN' `
    -Message "The server listens on all interfaces ($bindHost)." `
    -Action 'Use npm run exhibition for the narrow detected hotspot-IP bind; direct dev:exhibition remains useful for development.'
}
else {
  Add-VayriaCheck -Name 'bind' -Status 'OK' -Message "Bind host is $bindHost."
}

$port = 5187
$portValue = Get-VayriaSetting -Name 'VAYRIA_PORT'
if (-not [string]::IsNullOrWhiteSpace($portValue)) {
  try { $port = [int]$portValue } catch { $port = 0 }
}
if ($port -lt 1 -or $port -gt 65535) {
  Add-VayriaCheck `
    -Name 'port' `
    -Status 'FAIL' `
    -Message "Invalid VAYRIA_PORT: $portValue" `
    -Action 'Set VAYRIA_PORT=5187 or another port from 1 to 65535.'
}
else {
  Add-VayriaCheck -Name 'port' -Status 'OK' -Message "Configured port is $port."
}

$hotspot = Get-VayriaHotspotAdapter
if ($hotspot.Found) {
  $hotspotAlias = $hotspot.Adapter.Name
  $hotspotIp = $hotspot.Adapter.IPv4
  Add-VayriaCheck `
    -Name 'hotspot adapter' `
    -Status 'OK' `
    -Message "$hotspotAlias has IPv4 $hotspotIp."
}
elseif ($hotspot.Status -eq 'permission-denied') {
  $hotspotAlias = $null
  $hotspotIp = $null
  Add-VayriaCheck `
    -Name 'hotspot adapter' `
    -Status 'WARN' `
    -Message "Windows network adapter information was not readable: $($hotspot.Error)" `
    -Action 'Run the read-only check in an elevated PowerShell window, then turn on Mobile hotspot from Settings.'
}
else {
  $hotspotAlias = $null
  $hotspotIp = $null
  Add-VayriaCheck `
    -Name 'hotspot adapter' `
    -Status 'WARN' `
    -Message 'No usable Mobile Hotspot/Wi-Fi Direct IPv4 adapter was found.' `
    -Action "Start-Process 'ms-settings:network-mobilehotspot'; turn on the hotspot with SSID Vayria-Exhibition, then run this check again."
}

$httpsValue = (Get-VayriaSetting -Name 'VAYRIA_HTTPS')
$httpsEnabled = $httpsValue -match '^(1|true|yes|on)$'
$certificatePath = Get-VayriaSetting -Name 'VAYRIA_HTTPS_CERT_FILE'
$keyPath = Get-VayriaSetting -Name 'VAYRIA_HTTPS_KEY_FILE'
if (-not $httpsEnabled) {
  Add-VayriaCheck `
    -Name 'HTTPS' `
    -Status 'FAIL' `
    -Message 'HTTPS is disabled; iPad microphone/camera access and the exhibition URL require HTTPS.' `
    -Action 'Set VAYRIA_HTTPS=true and configure a certificate/key outside the repository.'
}
else {
  Add-VayriaCheck -Name 'HTTPS' -Status 'OK' -Message 'HTTPS is enabled.'
}

if ([string]::IsNullOrWhiteSpace($certificatePath) -or [string]::IsNullOrWhiteSpace($keyPath)) {
  Add-VayriaCheck `
    -Name 'certificate paths' `
    -Status 'FAIL' `
    -Message 'VAYRIA_HTTPS_CERT_FILE and VAYRIA_HTTPS_KEY_FILE must both be configured.' `
    -Action 'Use the shared HTTPS config file and keep the private key outside the repository.'
}
else {
  if (-not [IO.Path]::IsPathRooted($certificatePath)) {
    $certificatePath = [IO.Path]::GetFullPath((Join-Path $resolvedWorktree $certificatePath))
  }
  if (-not [IO.Path]::IsPathRooted($keyPath)) {
    $keyPath = [IO.Path]::GetFullPath((Join-Path $resolvedWorktree $keyPath))
  }
  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    Add-VayriaCheck `
      -Name 'HTTPS key' `
      -Status 'FAIL' `
      -Message 'Configured private key file was not found.' `
      -Action 'Create the certificate/key pair on the PC; never copy the private key to the iPad.'
  }
  $certificate = Get-VayriaCertificateStatus -CertificatePath $certificatePath
  if ($certificate.Status -ne 'available') {
    Add-VayriaCheck `
      -Name 'certificate' `
      -Status 'FAIL' `
      -Message "Certificate could not be read: $($certificate.Error)" `
      -Action 'Regenerate the mkcert certificate with SANs vayria.local localhost 127.0.0.1.'
  }
  elseif (-not $certificate.HasRequired) {
    Add-VayriaCheck `
      -Name 'certificate SAN' `
      -Status 'FAIL' `
      -Message "Required SANs are missing: $($certificate.Missing -join ', ')." `
      -Action 'Regenerate the certificate with: mkcert -cert-file vayria-cert.pem -key-file vayria-key.pem vayria.local localhost 127.0.0.1'
  }
  else {
    Add-VayriaCheck -Name 'certificate SAN' -Status 'OK' -Message 'vayria.local, localhost, and 127.0.0.1 are present.'
  }
  if ($hotspotIp -and $certificate.Names -notcontains $hotspotIp.ToLowerInvariant()) {
    Add-VayriaCheck `
      -Name 'fallback URL TLS' `
      -Status 'WARN' `
      -Message "The dynamic fallback IP $hotspotIp is not in the certificate SANs; use https://vayria.local:$port when mDNS is available." `
      -Action 'If mDNS is unavailable, regenerate the certificate with the currently detected hotspot IP as an additional SAN.'
  }
}

if ($hotspot.Found -and $port -ge 1 -and $port -le 65535) {
  $firewall = Get-VayriaFirewallStatus -InterfaceAlias $hotspotAlias -TcpPort $port
  if ($firewall.Status -eq 'permission-denied') {
    Add-VayriaCheck `
      -Name 'Firewall rules' `
      -Status 'WARN' `
      -Message "Firewall rules were not readable: $($firewall.Error)" `
      -Action 'Run this read-only check in an elevated PowerShell window; do not enable the Public profile.'
  }
  else {
    if ($firewall.TcpPort) {
      Add-VayriaCheck -Name "Firewall TCP $port" -Status 'OK' -Message "Private inbound access is allowed on $hotspotAlias."
    }
    else {
      Add-VayriaCheck `
        -Name "Firewall TCP $port" `
        -Status 'WARN' `
        -Message 'No matching enabled Private inbound TCP rule was found.' `
        -Action "New-NetFirewallRule -DisplayName 'Vayria Exhibition TCP $port (Private)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -InterfaceAlias '$hotspotAlias' -RemoteAddress LocalSubnet"
    }
    $mdnsEnabled = (Get-VayriaSetting -Name 'VAYRIA_MDNS_ENABLED') -notmatch '^(0|false|no|off)$'
    if (-not $mdnsEnabled) {
      Add-VayriaCheck -Name 'Firewall UDP 5353' -Status 'OK' -Message 'mDNS is disabled by configuration.'
    }
    elseif ($firewall.UdpPort) {
      Add-VayriaCheck -Name 'Firewall UDP 5353' -Status 'OK' -Message "Private inbound mDNS access is allowed on $hotspotAlias."
    }
    else {
      Add-VayriaCheck `
        -Name 'Firewall UDP 5353' `
        -Status 'WARN' `
        -Message 'No matching enabled Private inbound UDP 5353 rule was found; fallback IP still works.' `
        -Action "New-NetFirewallRule -DisplayName 'Vayria Exhibition mDNS UDP 5353 (Private)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Profile Private -InterfaceAlias '$hotspotAlias' -RemoteAddress LocalSubnet"
    }
  }
}

if (-not $Preflight) {
  $serverListening = if ($port -ge 1 -and $port -le 65535) {
    Test-VayriaTcpPort -ComputerName '127.0.0.1' -Port $port
  }
  else { $false }
  if (-not $serverListening) {
    Add-VayriaCheck `
      -Name 'Vite server' `
      -Status 'WARN' `
      -Message "Nothing is listening on local TCP port $port." `
      -Action 'Start the integrated launcher with npm run exhibition, then run this check again.'
  }
  else {
    Add-VayriaCheck -Name 'Vite server' -Status 'OK' -Message "TCP port $port is listening."
  }

  $healthTargets = [Collections.Generic.List[string]]::new()
  if ($hotspotIp) { [void]$healthTargets.Add("https://$hotspotIp`:$port") }
  [void]$healthTargets.Add("https://127.0.0.1`:$port")
  $health = $null
  foreach ($target in $healthTargets) {
    try {
      $healthResponse = Invoke-WebRequest `
        -Uri "$target/api/health" `
        -Method Get `
        -TimeoutSec 3 `
        -SkipCertificateCheck `
        -ErrorAction Stop
      $candidate = $healthResponse.Content | ConvertFrom-Json
      if ($candidate.ok -eq $true) {
        $health = $candidate
        break
      }
    }
    catch {
      # Try the next local/fallback address.
    }
  }
  if ($null -eq $health) {
    Add-VayriaCheck `
      -Name 'health' `
      -Status 'WARN' `
      -Message 'The exhibition health endpoint could not be reached.' `
      -Action "After startup, open https://vayria.local:$port/api/health or the displayed fallback URL."
  }
  else {
    if ($health.network.localNetwork -eq 'available') {
      Add-VayriaCheck -Name 'health local network' -Status 'OK' -Message 'Health endpoint reports localNetwork=available.'
    }
    else {
      Add-VayriaCheck -Name 'health local network' -Status 'FAIL' -Message 'Health endpoint reported localNetwork=unavailable.'
    }
    if ($health.network.internet -eq 'available') {
      Add-VayriaCheck -Name 'health internet' -Status 'OK' -Message 'Health endpoint reports internet=available.'
    }
    else {
      Add-VayriaCheck `
        -Name 'health internet' `
        -Status 'WARN' `
        -Message 'Health endpoint reports internet=unavailable; local UI and local API remain usable.'
    }
    if ($health.access.mdns -eq 'available') {
      Add-VayriaCheck -Name 'mDNS' -Status 'OK' -Message 'vayria.local is being advertised.'
    }
    elseif ($health.access.mdns -eq 'conflict') {
      Add-VayriaCheck `
        -Name 'mDNS' `
        -Status 'WARN' `
        -Message 'Another responder owns vayria.local; the dynamic fallback IP is still available.' `
        -Action 'Use the displayed fallback URL, or remove the conflicting mDNS/Bonjour responder on the hotspot network.'
    }
    else {
      if ($health.access.fallbackTlsValid -eq $true) {
        Add-VayriaCheck `
          -Name 'mDNS' `
          -Status 'WARN' `
          -Message 'mDNS is unavailable; the dynamic fallback IP is TLS-valid and may be used.'
      }
      else {
        Add-VayriaCheck `
          -Name 'mDNS' `
          -Status 'WARN' `
          -Message 'mDNS is unavailable and the dynamic fallback IP is not in the certificate SANs; do not present it as a valid HTTPS URL.' `
          -Action 'Restore mDNS or regenerate the certificate with the currently detected hotspot IP as an additional SAN.'
      }
    }
  }

  try {
    $aivisBaseUrl = Get-VayriaSetting -Name 'AIVIS_BASE_URL'
    if ([string]::IsNullOrWhiteSpace($aivisBaseUrl)) { $aivisBaseUrl = 'http://127.0.0.1:10101' }
    $speakers = @(Invoke-RestMethod -Uri "$aivisBaseUrl/speakers" -TimeoutSec 3 -ErrorAction Stop)
    if (@($speakers | Where-Object { $_.name -eq 'zonoko' }).Count -gt 0) {
      Add-VayriaCheck -Name 'AivisSpeech zonoko' -Status 'OK' -Message 'zonoko is available.'
    }
    else {
      Add-VayriaCheck -Name 'AivisSpeech zonoko' -Status 'FAIL' -Message 'AivisSpeech responded but zonoko was not found.' -Action 'Start the configured AivisSpeech Engine and confirm the zonoko speaker is installed.'
    }
  }
  catch {
    Add-VayriaCheck -Name 'AivisSpeech zonoko' -Status 'WARN' -Message 'AivisSpeech /speakers could not be reached.' -Action 'Run npm run exhibition, which starts the configured AivisSpeech process.'
  }

  if (Test-VayriaTcpPort -ComputerName '127.0.0.1' -Port 8787) {
    Add-VayriaCheck -Name 'Python STT' -Status 'OK' -Message 'STT port 8787 is listening on loopback.'
  }
  else {
    Add-VayriaCheck -Name 'Python STT' -Status 'WARN' -Message 'STT port 8787 is not listening.' -Action 'Run npm run exhibition and confirm the Python STT profile starts.'
  }

  if (Test-VayriaInternet) {
    Add-VayriaCheck -Name 'Internet probe' -Status 'OK' -Message 'The PC can reach the HTTPS probe endpoint.'
  }
  else {
    Add-VayriaCheck -Name 'Internet probe' -Status 'WARN' -Message 'The PC cannot reach the HTTPS probe endpoint; local exhibition traffic is not blocked by this result.'
  }
}

Write-Host ("Summary: {0} failure(s), {1} warning(s)." -f $failures, $warnings) -ForegroundColor Cyan
if ($failures -gt 0) { exit 1 }
exit 0
