# MusePi Installer (PowerShell)
# Usage: irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex
#
# Options (via environment variables, since `irm | iex` has no argv):
#   $env:PI_REF        Install a specific tag/commit/branch
#   $env:PI_CLONE_DIR  Override the checkout directory (default ~\.musepi\repo)

$ErrorActionPreference = "Stop"
$repo = "MuseLinn/MusePi"
$cloneDir = if ($env:PI_CLONE_DIR) { $env:PI_CLONE_DIR } else { Join-Path $HOME ".musepi\repo" }
$ref = $env:PI_REF

# Bun is required for the workspace setup and the run command.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Installing bun (required for from-source install)..."
    irm https://bun.sh/install.ps1 | iex
}

# git is required to clone the repo.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git is required to install from source. Install it from https://git-scm.com/"
    exit 1
}

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