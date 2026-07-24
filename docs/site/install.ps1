# MusePi installer for Windows.
#
#   irm https://muselinn.github.io/MusePi/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://muselinn.github.io/MusePi/install.ps1))) -Version v0.1.0
#
# Environment overrides:
#   $env:MUSEPI_INSTALL_DIR     install root (default: %LOCALAPPDATA%\Programs\musepi)
#   $env:MUSEPI_DOWNLOAD_URL    full asset URL override (mirror/proxy/testing)
#
# Layout note: the release zip keeps MusePi as a directory — musepi.exe needs
# its sibling package.json (version display) plus theme\, export-html\ and
# friends — so the whole archive is extracted into the install directory and
# that directory is added to the user PATH.

param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is much faster without the progress bar

$Repo = "MuseLinn/MusePi"
$InstallDir = if ($env:MUSEPI_INSTALL_DIR) { $env:MUSEPI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\musepi" }

# --- architecture -------------------------------------------------------------
# PROCESSOR_ARCHITECTURE can be empty in some launch contexts (e.g. certain
# MSYS/Cygwin shells), so fall back to RuntimeInformation.
$Arch = $env:PROCESSOR_ARCHITECTURE
if (-not $Arch) {
    try { $Arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToUpperInvariant() } catch { $Arch = "" }
}
switch -Regex ($Arch) {
    "^(AMD64|X64)$"   { $Asset = "musepi-windows-x64.zip" }
    "^ARM64"          { $Asset = "musepi-windows-arm64.zip" }
    default { throw "Unsupported architecture: '$Arch' (supported: x64, arm64)" }
}

if ($env:MUSEPI_DOWNLOAD_URL) {
    $Url = $env:MUSEPI_DOWNLOAD_URL
} elseif ($Version) {
    $Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
} else {
    $Url = "https://github.com/$Repo/releases/latest/download/$Asset"
}

# --- download & extract ---------------------------------------------------------
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("musepi-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
    $ZipPath = Join-Path $TmpDir $Asset
    Write-Host "Downloading $Asset ..."
    try {
        Invoke-WebRequest -Uri $Url -OutFile $ZipPath -TimeoutSec 900 -UseBasicParsing
    } catch {
        throw "Download failed: $Url`nCheck https://github.com/$Repo/releases for available assets.`n$_"
    }

    Write-Host "Installing to $InstallDir ..."
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $InstallDir

    $Exe = Join-Path $InstallDir "musepi.exe"
    if (-not (Test-Path $Exe)) { throw "Executable missing after extract: $Exe" }
    if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
        throw "Unexpected archive layout: package.json is not next to musepi.exe"
    }

    # --- PATH (user level) ------------------------------------------------------
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if ($UserPath) { $entries = $UserPath -split ";" | ForEach-Object { $_.TrimEnd("\") } }
    $needsRestart = $entries -notcontains $InstallDir.TrimEnd("\")
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to your user PATH ..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }
    # Make it available in this session too (for the verify step below).
    $env:Path = "$InstallDir;$env:Path"

    # --- verify -------------------------------------------------------------------
    Write-Host ""
    $VersionOut = & $Exe --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "musepi.exe --version failed: $VersionOut" }
    Write-Host "Installed: $VersionOut" -ForegroundColor Green
    Write-Host "Location:  $Exe"

    if ($needsRestart) {
        Write-Host ""
        Write-Host "Open a NEW terminal, then run: musepi" -ForegroundColor Yellow
    } else {
        Write-Host "Run 'musepi' to get started!"
    }
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
