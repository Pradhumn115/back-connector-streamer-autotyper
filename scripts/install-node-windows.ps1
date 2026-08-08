# Fallback Node.js installer for Windows, used by install.bat when winget
# isn't available (Windows 10 before 1809, LTSC images, or a machine whose App
# Installer is broken).
#
# Downloads the current LTS MSI straight from nodejs.org and installs it
# silently. Must run elevated - install.bat has already handled that.
$ErrorActionPreference = 'Stop'

$ltsMajor = 22
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = "https://nodejs.org/dist/latest-v$ltsMajor.x"

# TLS 1.2 isn't the default on older Windows PowerShell hosts, and nodejs.org
# refuses anything less.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "  Looking up the latest Node $ltsMajor.x build..."
$listing = (Invoke-WebRequest -UseBasicParsing -Uri "$base/").Content
$match = [regex]::Match($listing, "node-v[0-9]+\.[0-9]+\.[0-9]+-$arch\.msi")
if (-not $match.Success) {
  Write-Host "  No Node $ltsMajor.x MSI found for $arch. Install manually from https://nodejs.org"
  exit 1
}

$file = $match.Value
$url = "$base/$file"
$dest = Join-Path $env:TEMP $file

Write-Host "  Downloading $url"
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest

Write-Host "  Installing $file (silent)..."
$proc = Start-Process -FilePath 'msiexec.exe' `
  -ArgumentList @('/i', "`"$dest`"", '/qn', '/norestart') `
  -Wait -PassThru
Remove-Item $dest -ErrorAction SilentlyContinue

# 3010 is "success, a reboot is pending" - Node itself works right away.
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
  Write-Host "  msiexec failed with exit code $($proc.ExitCode)"
  exit 1
}

Write-Host "  Node.js installed."
exit 0
