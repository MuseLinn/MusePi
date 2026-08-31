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
    try {
        Install-Binary
        return 0
    } catch {
        Write-Host "Prebuilt binary install failed ($($_.Exception.Message))"
        Write-Host "Falling back to from-source install. Set PI_SOURCE=1 to force source."
    }
}

Install-FromSource
