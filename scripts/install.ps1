# MusePi Installer (PowerShell)
# Usage: irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex
#
# Default installs the prebuilt TUI binary published by the release CICD
# (musepi-windows-x64.exe + SHA256SUMS.txt on the GitHub release). Fall back
# to a from-source build when no prebuilt binary matches this host or when
# PI_SOURCE is set.
#
# Options (via environment variables, since `irm | iex` has no argv):
#   $env:PI_REF        Install a specific release tag (default: latest)
#   $env:PI_SOURCE=1   Force install from source (clone + build)
#   $env:PI_BIN_DIR    Binary install directory (default ~\.musepi\bin)
#   $env:PI_CLONE_DIR  Source checkout directory (default ~\.musepi\repo)

$ErrorActionPreference = "Stop"

# Force TLS 1.2 for GitHub HTTPS calls: Windows PowerShell 5.1 defaults to
# TLS 1.0, which GitHub deprecated — without this the download fails with a
# "The request was aborted: Could not create SSL/TLS secure channel" error.
# Harmless on PowerShell 7+ where TLS 1.2 is already the minimum.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Older .NET without Tls12 enum — let the download surface the real error.
}

$repo = "MuseLinn/MusePi"
$ref = $env:PI_REF
$binDir = if ($env:PI_BIN_DIR) { $env:PI_BIN_DIR } else { Join-Path $HOME ".musepi\bin" }
$sourceInstall = $env:PI_SOURCE -eq "1"

function Get-LatestReleaseTag {
    param([string]$Repo)
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "musepi-installer" }
    return $release.tag_name
}

function Add-BinToPath {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -split ";" -contains $Dir) { return }
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $Dir } else { "$userPath;$Dir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $Dir to your user PATH (new terminals will pick it up)."
}

function Install-Binary {
    $asset = "musepi-windows-x64.exe"
    $tag = if ($ref) { $ref } else { Get-LatestReleaseTag $repo }
    $baseUrl = "https://github.com/$repo/releases/download/$tag"
    $assetUrl = "$baseUrl/$asset"
    $checksumUrl = "$baseUrl/SHA256SUMS.txt"

    Write-Host "Downloading musepi $tag ($asset) ..."
    $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "musepi-install") -Force
    $tmpAsset = Join-Path $tmp $asset
    $tmpChecksums = Join-Path $tmp "SHA256SUMS.txt"

    Invoke-WebRequest -Uri $assetUrl -OutFile $tmpAsset
    Invoke-WebRequest -Uri $checksumUrl -OutFile $tmpChecksums

    # SHA256SUMS.txt lines are "<sha256>  <basename>".
    $expectedLine = Get-Content $tmpChecksums | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" }
    if (-not $expectedLine) {
        throw "SHA256SUMS.txt has no entry for $asset"
    }
    $expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash $tmpAsset -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw "Checksum mismatch for $asset (expected $expected, got $actual)"
    }

    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $binPath = Join-Path $binDir "musepi.exe"
    Move-Item -Force $tmpAsset $binPath
    Remove-Item -Recurse -Force $tmp

    Write-Host "Verifying binary ..."
    $version = & $binPath --version
    if ($LASTEXITCODE -ne 0) { throw "Installed musepi binary failed --version" }

    Add-BinToPath $binDir
    Write-Host ""
    Write-Host "✓ Installed musepi $version (TUI binary)"
    Write-Host "Run: musepi   (or $binPath if PATH is not refreshed)"
    return $true
}

function Install-BinaryViaRedirect {
    # Retry path when the GitHub REST API is unavailable (rate limit 60/hr
    # unauth, corporate proxies): /releases/latest/download/<asset> is a
    # plain HTTP redirect that needs no API call. Checksum verification is
    # identical to Install-Binary, so a bad download still cannot install.
    $asset = "musepi-windows-x64.exe"
    $baseUrl = "https://github.com/$repo/releases/latest/download"
    $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "musepi-install") -Force
    $tmpAsset = Join-Path $tmp $asset
    $tmpChecksums = Join-Path $tmp "SHA256SUMS.txt"

    Write-Host "Downloading musepi (latest, redirect) ..."
    Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $tmpAsset
    Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS.txt" -OutFile $tmpChecksums

    $expectedLine = Get-Content $tmpChecksums | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" }
    if (-not $expectedLine) {
        throw "SHA256SUMS.txt has no entry for $asset"
    }
    $expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash $tmpAsset -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw "Checksum mismatch for $asset (expected $expected, got $actual)"
    }

    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $binPath = Join-Path $binDir "musepi.exe"
    Move-Item -Force $tmpAsset $binPath
    Remove-Item -Recurse -Force $tmp

    Write-Host "Verifying binary ..."
    $version = & $binPath --version
    if ($LASTEXITCODE -ne 0) { throw "Installed musepi binary failed --version" }

    Add-BinToPath $binDir
    Write-Host ""
    Write-Host "✓ Installed musepi $version (TUI binary)"
    Write-Host "Run: musepi   (or $binPath if PATH is not refreshed)"
    return $true
}

function Install-FromSource {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "git is required to install from source. Install it from https://git-scm.com/"
        return 1
    }

    $cloneDir = if ($env:PI_CLONE_DIR) { $env:PI_CLONE_DIR } else { Join-Path $HOME ".musepi\repo" }

    if (Test-Path (Join-Path $cloneDir ".git")) {
        Write-Host "Using existing checkout at $cloneDir"
        Push-Location $cloneDir
        try {
            if ($ref) {
                git fetch --depth 1 origin $ref 2>$null
                git checkout -f $ref
                if ($LASTEXITCODE -ne 0) { throw "Failed to checkout $ref" }
            } else {
                git pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw "Failed to update checkout" }
            }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "Cloning $repo ..."
        if ($ref) {
            git clone --depth 1 --branch $ref "https://github.com/$repo.git" $cloneDir 2>$null
            if ($LASTEXITCODE -ne 0) {
                git clone "https://github.com/$repo.git" $cloneDir
            }
        } else {
            git clone --depth 1 "https://github.com/$repo.git" $cloneDir
        }
        if ($LASTEXITCODE -ne 0) { throw "Clone failed" }
    }

    if (-not (Test-Path (Join-Path $cloneDir "packages\coding-agent"))) {
        throw "Expected package at $cloneDir\packages\coding-agent"
    }

    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Host "Installing bun (required for from-source install)..."
        irm https://bun.sh/install.ps1 | iex
    }

    # Min Bun version gate (mirrors install.sh MIN_BUN_VERSION): bun 1.3.x
    # reports e.g. "1.3.14"; strip any -dev suffix before comparing.
    $minBun = [version]"1.3.14"
    $bunVersionRaw = & bun --version 2>$null
    if (-not $bunVersionRaw) {
        throw "Failed to read bun version"
    }
    $bunVersionClean = ($bunVersionRaw -split "-")[0]
    try {
        $bunVersion = [version]$bunVersionClean
    } catch {
        throw "Could not parse bun version '$bunVersionRaw'"
    }
    if ($bunVersion -lt $minBun) {
        throw "Bun $minBun or newer is required. Current version: $bunVersionClean. Upgrade at https://bun.sh/docs/installation"
    }

    Write-Host "Running setup (workspace install + natives + link)..."
    Push-Location $cloneDir
    try {
        bun run setup
        if ($LASTEXITCODE -ne 0) { throw "bun run setup failed" }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "✓ Installed musepi from source"
    Write-Host "Run: cd $cloneDir; bun run musepi"
    return $true
}

if (-not $sourceInstall) {
    # Default is the prebuilt binary. A failure here is NOT silently
    # converted into a 20-minute from-source build: network/API errors would
    # otherwise surface as "compiled from source" with no hint anything was
    # wrong, and the from-source path would happily reuse a stale checkout.
    # Only an explicit PI_SOURCE=1 opts into compiling.
    try {
        Install-Binary
        return 0
    } catch {
        Write-Host ""
        Write-Host "Prebuilt binary install failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "Retrying with the GitHub releases/latest redirect (no API call)..."
        try {
            $env:PI_REF = ""
            Install-BinaryViaRedirect
            return 0
        } catch {
            Write-Host ""
            Write-Host "Binary download failed again: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host ""
            Write-Host "To install from source instead, run with the environment variable PI_SOURCE=1:"
            Write-Host "  `$env:PI_SOURCE='1'; irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex"
            exit 1
        }
    }
}

Install-FromSource
