[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapperScript = Join-Path $scriptDirectory 'Start-VayriaWithOnePassword.ps1'
$pwshCommand = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "vayria-onepassword-$([Guid]::NewGuid().ToString('N'))"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)

if (-not $resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The test directory is outside the system temporary directory.'
}

function Invoke-Wrapper {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ReferencePath,

    [Parameter(Mandatory = $true)]
    [string]$FakeOpPath
  )

  $arguments = @(
    '-NoProfile'
    '-File'
    $wrapperScript
    '-ReferenceFile'
    $ReferencePath
    '-CommandPath'
    'node.exe'
    '-OpCommand'
    $FakeOpPath
    '-CommandArguments'
    'run dev'
  )

  & $pwshCommand @arguments *> $null
  return $LASTEXITCODE
}

try {
  New-Item -ItemType Directory -Path $resolvedTestRoot -Force | Out-Null

  $fakeOpPath = Join-Path $resolvedTestRoot 'op.cmd'
  $recordPath = Join-Path $resolvedTestRoot 'op-arguments.txt'
  Set-Content -LiteralPath $fakeOpPath -Value @(
    '@echo off'
    'if /I "%~1"=="whoami" exit /b 0'
    '> "%VAYRIA_FAKE_OP_RECORD%" echo %*'
    'exit /b 23'
  ) -Encoding ascii
  $env:VAYRIA_FAKE_OP_RECORD = $recordPath

  $missingReferencePath = Join-Path $resolvedTestRoot 'missing.env'
  $missingExitCode = Invoke-Wrapper -ReferencePath $missingReferencePath -FakeOpPath $fakeOpPath
  if ($missingExitCode -eq 0) {
    throw 'The wrapper accepted a missing 1Password reference file.'
  }

  $plaintextReferencePath = Join-Path $resolvedTestRoot 'plaintext.env'
  Set-Content -LiteralPath $plaintextReferencePath -Value 'OPENAI_API_KEY=plain-test-value' -Encoding utf8
  $plaintextExitCode = Invoke-Wrapper -ReferencePath $plaintextReferencePath -FakeOpPath $fakeOpPath
  if ($plaintextExitCode -eq 0) {
    throw 'The wrapper accepted a plaintext API key.'
  }

  $plaintextCloudReferencePath = Join-Path $resolvedTestRoot 'plaintext-cloud.env'
  Set-Content -LiteralPath $plaintextCloudReferencePath -Value @(
    'OPENAI_API_KEY=op://vault/item/field'
    'AIVIS_CLOUD_API_KEY=plain-cloud-test-value'
  ) -Encoding utf8
  $plaintextCloudExitCode = Invoke-Wrapper `
    -ReferencePath $plaintextCloudReferencePath `
    -FakeOpPath $fakeOpPath
  if ($plaintextCloudExitCode -eq 0) {
    throw 'The wrapper accepted a plaintext Aivis Cloud API key.'
  }

  $validReferencePath = Join-Path $resolvedTestRoot 'vayria-op.env'
  Set-Content -LiteralPath $validReferencePath -Value @(
    '# Reference only.'
    'OPENAI_API_KEY=op://vault/item/field'
    'AIVIS_CLOUD_API_KEY=op://vault/cloud/key'
  ) -Encoding utf8
  $validExitCode = Invoke-Wrapper -ReferencePath $validReferencePath -FakeOpPath $fakeOpPath
  if ($validExitCode -ne 23) {
    throw "The wrapper did not forward the op exit code. Expected 23, got $validExitCode."
  }

  $recordedArguments = Get-Content -Raw -LiteralPath $recordPath
  foreach ($expectedToken in @('run', '--env-file', $validReferencePath, '--', 'node.exe', 'dev')) {
    if (-not $recordedArguments.Contains($expectedToken, [StringComparison]::OrdinalIgnoreCase)) {
      throw "The wrapper did not pass the expected op argument: $expectedToken"
    }
  }
  if ($recordedArguments.Contains('plain-test-value', [StringComparison]::Ordinal)) {
    throw 'The wrapper exposed the plaintext test value to the op command.'
  }
  if ($recordedArguments.Contains('op://vault/item/field', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The wrapper exposed the 1Password reference value to the op command.'
  }
  if ($recordedArguments.Contains('op://vault/cloud/key', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The wrapper exposed the Aivis Cloud reference value to the op command.'
  }

  Write-Output 'Vayria 1Password wrapper tests passed.'
}
finally {
  Remove-Item Env:VAYRIA_FAKE_OP_RECORD -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
