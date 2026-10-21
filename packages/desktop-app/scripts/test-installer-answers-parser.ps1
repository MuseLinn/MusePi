#!/usr/bin/env pwsh
# Verify the NSIS answers.ini parser against edge cases.
#
# Why this test exists: MuseApplyHostAnswers is hand-written NSIS string
# splitting (NSIS has no JSON parser, and StrLoc lives in electron-builder's
# template dir, not the stock include path). Off-by-one slicing on paths with
# spaces or '=' is exactly the kind of bug that ships an installer pointing at
# the wrong directory.
#
# The test compiles test/installer-parser-test.nsi (which calls the PRODUCTION
# function), feeds it a fixture, and asserts the parsed values.
#
# Usage: pwsh -File packages/desktop-app/scripts/test-installer-answers-parser.ps1

$ErrorActionPreference = "Stop"

$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$appDir = Join-Path $repo "packages\desktop-app"
$testNsi = Join-Path $appDir "test\installer-parser-test.nsi"
$exe = Join-Path $appDir "release\answers-parser-test.exe"

$makensis = if ($env:MAKENSIS) { $env:MAKENSIS } else {
    $found = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis" -Recurse -Filter "makensis.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1
    if (-not $found) { throw "makensis not found; run any electron-builder win build once" }
    $found.FullName
}

# Isolated temp dir: this machine's real %TEMP% is not usable by NSIS
# ("Error writing temporary file"), so every NSIS run here gets its own.
$temp = Join-Path $repo ".tmp\parser-test-temp"
New-Item -ItemType Directory -Force -Path $temp | Out-Null

Write-Host "[parser-test] compiling…"
& $makensis /V1 /INPUTCHARSET UTF8 "/DPROJECT_DIR=$appDir" "/DBUILD_RESOURCES_DIR=$appDir\build" $testNsi 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "compile failed (exit $LASTEXITCODE)" }

# Fixture covers the four shapes that broke naive implementations:
#   * a path containing '='          -> must split on the FIRST '='
#   * a path containing spaces       -> must not trim interior spaces
#   * a blank line                   -> must be skipped, not treated as a pair
#   * a '0' value                    -> must stay "0" (not become empty)
$fixture = @(
    'path=C:\Program Files\MusePi = test\app'
    'language=zh-CN'
    'desktopShortcut=0'
    ''
    'startMenu=1'
) -join "`r`n"
$fixturePath = Join-Path $temp "musepi-parser-fixture.ini"
[System.IO.File]::WriteAllText($fixturePath, $fixture + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[parser-test] running…"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["TEMP"] = $temp
$psi.EnvironmentVariables["TMP"] = $temp
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc.WaitForExit(30000)) { try { $proc.Kill() } catch {}; throw "parser test timed out" }

$resultPath = Join-Path $temp "musepi-parser-result.txt"
if (-not (Test-Path $resultPath)) { throw "no result file: $resultPath" }
$result = Get-Content $resultPath -Raw

$expectations = [ordered]@{
    "path=[C:\Program Files\MusePi = test\app]" = "path with '=' and spaces"
    "language=[zh-CN]"                           = "language"
    "desktopShortcut=[0]"                        = "boolean 0 preserved"
    "startMenu=[1]"                              = "boolean 1 after blank line"
}

$failures = @()
foreach ($expected in $expectations.Keys) {
    # -like/-match would treat the brackets in 'path=[...]' as wildcards; this is
    # a literal containment check.
    if (-not $result.Contains($expected)) {
        $failures += "missing $($expectations[$expected]): expected '$expected'"
    }
}

if ($failures.Count -gt 0) {
    Write-Host "[parser-test] FAILED" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host "  actual:"; Write-Host ($result -replace "`r`n", "`n  ")
    exit 1
}

Write-Host "[parser-test] PASS  (4 assertions: '=' in path, spaces, blank line, 0/1 flags)"
exit 0
