Set-StrictMode -Version Latest

function Test-VayriaUsableIpv4 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Address
  )

  try {
    $parsed = [Net.IPAddress]::Parse($Address)
  }
  catch {
    return $false
  }

  if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }

  return $Address -notmatch '^(0|127\.|169\.254\.)'
}

function Get-VayriaHotspotAdapter {
  [CmdletBinding()]
  param()

  $namePattern = 'Wi[- ]?Fi\s+Direct|Mobile\s+Hotspot|Local\s+Area\s+Connection|ローカル\s*エリア\s*接続|モバイル\s*ホットスポット'
  try {
    $adapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object {
        $_.Status -eq 'Up' -and
        ($_.Name -match $namePattern -or $_.InterfaceDescription -match $namePattern)
      })
  }
  catch {
    return [PSCustomObject]@{
      Status  = 'permission-denied'
      Found   = $false
      Error   = $_.Exception.Message
      Adapter = $null
    }
  }

  $candidates = [Collections.Generic.List[object]]::new()
  foreach ($adapter in $adapters) {
    try {
      $addresses = @(Get-NetIPAddress `
          -InterfaceIndex $adapter.ifIndex `
          -AddressFamily IPv4 `
          -ErrorAction Stop | Where-Object {
            Test-VayriaUsableIpv4 -Address $_.IPAddress
          })
    }
    catch {
      continue
    }

    foreach ($address in $addresses) {
      $score = 0
      if ($adapter.Name -match 'Mobile\s+Hotspot|モバイル\s*ホットスポット') {
        $score += 30
      }
      if ($adapter.Name -match 'Local\s+Area\s+Connection|ローカル\s*エリア\s*接続') {
        $score += 20
      }
      if ($adapter.InterfaceDescription -match 'Wi[- ]?Fi\s+Direct') {
        $score += 10
      }
      [void]$candidates.Add([PSCustomObject]@{
          Score   = $score
          Adapter = $adapter
          Address = $address.IPAddress
        })
    }
  }

  $selected = $candidates | Sort-Object -Property Score -Descending | Select-Object -First 1
  if ($null -eq $selected) {
    return [PSCustomObject]@{
      Status  = 'not-found'
      Found   = $false
      Error   = $null
      Adapter = $null
    }
  }

  return [PSCustomObject]@{
    Status  = 'available'
    Found   = $true
    Error   = $null
    Adapter = [PSCustomObject]@{
      Name                = $selected.Adapter.Name
      InterfaceDescription = $selected.Adapter.InterfaceDescription
      InterfaceIndex      = $selected.Adapter.ifIndex
      Status              = $selected.Adapter.Status
      IPv4                = $selected.Address
    }
  }
}

function Test-VayriaInternet {
  [CmdletBinding()]
  param(
    [int]$TimeoutSeconds = 3
  )

  try {
    $null = Invoke-WebRequest `
      -Uri 'https://www.msftconnecttest.com/connecttest.txt' `
      -Method Get `
      -TimeoutSec $TimeoutSeconds `
      -MaximumRedirection 2 `
      -SkipCertificateCheck `
      -ErrorAction Stop
    return $true
  }
  catch {
    return $false
  }
}

function Test-VayriaTcpPort {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName,

    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    return [bool](Test-NetConnection `
        -ComputerName $ComputerName `
        -Port $Port `
        -InformationLevel Quiet `
        -WarningAction SilentlyContinue `
        -ErrorAction Stop)
  }
  catch {
    return $false
  }
}

function Get-VayriaFirewallStatus {
  [CmdletBinding()]
  param(
    [string]$InterfaceAlias,

    [int]$TcpPort = 5187,

    [int]$MdnsPort = 5353
  )

  try {
    $rules = @(Get-NetFirewallRule `
        -Direction Inbound `
        -Action Allow `
        -Enabled True `
        -ErrorAction Stop)
  }
  catch {
    return [PSCustomObject]@{
      Status = 'permission-denied'
      Error  = $_.Exception.Message
      TcpPort = $false
      UdpPort = $false
    }
  }

  function Test-Rule {
    param(
      [Parameter(Mandatory = $true)]
      [object]$Rule,

      [Parameter(Mandatory = $true)]
      [string]$Protocol,

      [Parameter(Mandatory = $true)]
      [string]$Port
    )

    try {
      $portFilters = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
      $portMatch = $portFilters | Where-Object {
        $_.Protocol.ToString() -ieq $Protocol -and
        ($_.LocalPort.ToString() -split ',') -contains $Port
      } | Select-Object -First 1
      if ($null -eq $portMatch) { return $false }

      $profile = $Rule.Profile.ToString()
      $privateProfile = $profile -match 'Private' -or $profile -eq '2'
      if (-not $privateProfile) { return $false }

      if (-not [string]::IsNullOrWhiteSpace($InterfaceAlias)) {
        $interfaceFilters = @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $interfaceMatch = $interfaceFilters | Where-Object {
          [string]::IsNullOrWhiteSpace($_.InterfaceAlias) -or
          $_.InterfaceAlias -eq 'Any' -or
          @($_.InterfaceAlias) -contains $InterfaceAlias
        } | Select-Object -First 1
        if ($null -eq $interfaceMatch) { return $false }
      }

      return $true
    }
    catch {
      return $false
    }
  }

  $tcp = $false
  $udp = $false
  foreach ($rule in $rules) {
    if (-not $tcp -and (Test-Rule -Rule $rule -Protocol 'TCP' -Port ([string]$TcpPort))) {
      $tcp = $true
    }
    if (-not $udp -and (Test-Rule -Rule $rule -Protocol 'UDP' -Port ([string]$MdnsPort))) {
      $udp = $true
    }
    if ($tcp -and $udp) { break }
  }

  return [PSCustomObject]@{
    Status = 'available'
    Error  = $null
    TcpPort = $tcp
    UdpPort = $udp
  }
}

function Get-VayriaCertificateStatus {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$CertificatePath,

    [string[]]$RequiredNames = @('vayria.local', 'localhost', '127.0.0.1')
  )

  if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    return [PSCustomObject]@{
      Status       = 'not-found'
      Path         = $CertificatePath
      HasRequired  = $false
      Names        = @()
      Error        = 'Certificate file was not found.'
    }
  }

  try {
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
    $sanExtension = $certificate.Extensions | Where-Object {
      $_.Oid.Value -eq '2.5.29.17'
    } | Select-Object -First 1
    $sanText = if ($null -eq $sanExtension) { '' } else { $sanExtension.Format($true) }
    $names = [Collections.Generic.List[string]]::new()
    foreach ($pattern in @(
        '(?im)DNS(?: Name)?\s*[=:]\s*([^\r\n,]+)'
        '(?im)IP(?: Address)?\s*[=:]\s*([^\r\n,]+)'
        '(?im)DNS名\s*[=:]\s*([^\r\n,]+)'
        '(?im)IPアドレス\s*[=:]\s*([^\r\n,]+)'
      )) {
      foreach ($match in [Regex]::Matches($sanText, $pattern)) {
        [void]$names.Add($match.Groups[1].Value.Trim())
      }
    }
    $normalizedNames = @($names | ForEach-Object { $_.ToLowerInvariant() })
    $missing = @($RequiredNames | Where-Object {
        $normalizedNames -notcontains $_.ToLowerInvariant()
      })
    return [PSCustomObject]@{
      Status      = 'available'
      Path        = $CertificatePath
      HasRequired = $missing.Count -eq 0
      Names       = $normalizedNames
      Missing     = $missing
      Error       = $null
    }
  }
  catch {
    return [PSCustomObject]@{
      Status      = 'invalid'
      Path        = $CertificatePath
      HasRequired = $false
      Names       = @()
      Error       = $_.Exception.Message
    }
  }
}
