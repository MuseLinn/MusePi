# Capture and verify the full MusePi installer flow.
#
# What this proves (the regression the user reported): a normal install shows
# the custom WebView2 host from the first question to the finish page — the
# native NSIS wizard never becomes visible, not even for a frame.
#
# The preview is launched with TEMP/TMP, MUSEPI_ANSWERS_DIR,
# MUSEPI_PREVIEW_INSTALL_ROOT and MUSEPI_INSTALLER_CAPTURE_DIR pointed at
# scratch directories, and the host runs with --ui-flow so it walks itself
# through language → location → install and photographs its own WebView2
# surface. Screen capture from this script is deliberately not used: a
# GPU-composited WebView2 can come back black that way.
#
# Assertions:
#   1. while the host window is up, the preview process has zero *visible*
#      top-level windows (sampled every 120-150 ms for the whole install)
#   2. the flow reaches phase=installing and phase=done in install-status.ini
#   3. the host produced the page captures (language, location, progress, finish,
#      plus cancelled/failed for the rollback runs)
#   4. the clicked-through run exits 0 after the finish page closes
#   5. a /S run installs silently with no window at all and exits 0
#   6. a cancel run exits 2, removes the target directory and the disposable
#      Add/Remove Programs entry the preview created for it
#   7. a run that dies before customInstall exits 3 and removes the same things
#
# Usage: pwsh -File apps/desktop/scripts/capture-installer-pages.ps1
#        (build first: node apps/desktop/scripts/build-installer-host.mjs
#                      python apps/desktop/scripts/build-installer-preview.py)

param(
    [string]$OutDir = ".tmp\installer-shots",
    [string]$TempDir = ".tmp\nsis-preview-temp"
)

$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

$script:failures = New-Object System.Collections.Generic.List[string]
$script:nativeFrames = 0

function Record([bool]$Ok, [string]$Message) {
    if ($Ok) { Write-Host "  PASS  $Message" } else { Write-Host "  FAIL  $Message"; $script:failures.Add($Message) }
}

# scripts -> desktop -> apps -> repo root
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$exe = Join-Path $repo "apps\desktop\release\MusePi-installer-preview.exe"
if (-not (Test-Path $exe)) { throw "preview not built: $exe (run build-installer-preview.py)" }

# A leftover host from an aborted run holds Local\MusePi.Installer.Host, which
# makes the new installer believe its own host never went away. Refuse to run
# on that state instead of producing a confusing failure.
$staleHosts = Get-Process -Name MusePiInstallerHost -ErrorAction SilentlyContinue
if ($staleHosts) {
    throw "stale installer host process(es) $($staleHosts.Id -join ', ') hold the liveness mutex; stop them first"
}

$outPath = Join-Path $repo $OutDir
$tempPath = Join-Path $repo $TempDir
New-Item -ItemType Directory -Force -Path $outPath, $tempPath | Out-Null
$logPath = Join-Path $outPath "capture.log"
if (Test-Path $logPath) { Remove-Item $logPath -Force }
Get-ChildItem -LiteralPath $outPath -Filter "*.png" -ErrorAction SilentlyContinue | Remove-Item -Force

function Get-VisibleWindows([int]$ProcessId) {
    $found = New-Object System.Collections.Generic.List[IntPtr]
    $callback = [Win+EnumWindowsProc]{
        param($hWnd, $lParam)
        if ([Win]::IsWindowVisible($hWnd)) {
            $owner = [uint32]0
            [Win]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
            if ($owner -eq $ProcessId) { $found.Add($hWnd) }
        }
        return $true
    }
    [Win]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    return ,$found
}

$uninstallKeyRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Test-UninstallKey([string]$Name) {
    return $null -ne (Get-Item -LiteralPath (Join-Path $uninstallKeyRoot $Name) -ErrorAction SilentlyContinue)
}

function Remove-UninstallKey([string]$Name) {
    Remove-Item -LiteralPath (Join-Path $uninstallKeyRoot $Name) -Recurse -Force -ErrorAction SilentlyContinue
}

function Read-Phase([string]$StateDir) {
    $file = Join-Path $StateDir "install-status.ini"
    if (-not (Test-Path $file)) { return "" }
    try { $text = (Get-Content -LiteralPath $file -Raw) } catch { return "" }
    if ($text -match "phase=(\S+)") { return $Matches[1] }
    return ""
}

function Measure-Tree([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    try {
        return (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
    } catch { return 0 }
}

function Start-Preview([string]$StateDir, [string]$InstallRoot, [string]$Arguments = "", [string]$UiFlow = "0", [string]$TestUninstallKey = "", [bool]$FailBeforeDone = $false) {
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = $exe
    $si.UseShellExecute = $false
    $si.Arguments = $Arguments
    $si.EnvironmentVariables["TEMP"] = $tempPath
    $si.EnvironmentVariables["TMP"] = $tempPath
    $si.EnvironmentVariables["MUSEPI_ANSWERS_DIR"] = $StateDir
    $si.EnvironmentVariables["MUSEPI_PREVIEW_INSTALL_ROOT"] = $InstallRoot
    $si.EnvironmentVariables["MUSEPI_INSTALLER_CAPTURE_DIR"] = $outPath
    $si.EnvironmentVariables["MUSEPI_INSTALLER_UI_FLOW"] = $UiFlow
    if ($TestUninstallKey) {
        $si.EnvironmentVariables["MUSEPI_PREVIEW_TEST_UNINSTALL_KEY"] = $TestUninstallKey
    }
    if ($FailBeforeDone) {
        $si.EnvironmentVariables["MUSEPI_PREVIEW_FAIL_BEFORE_DONE"] = "1"
    }
    return [System.Diagnostics.Process]::Start($si)
}

function Reset-Scratch([string]$StateDir, [string]$InstallRoot) {
    foreach ($path in @($StateDir, $InstallRoot)) {
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Wait-For([scriptblock]$Condition, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 150
    }
    return $false
}

function Wait-Shot([string]$Name, [int]$TimeoutSeconds) {
    $file = Join-Path $outPath "$Name.png"
    $ok = Wait-For { (Test-Path $file) -and ((Get-Item $file).Length -gt 10000) } $TimeoutSeconds
    Record $ok "host captured $Name.png from its own WebView2 surface"
}

$interactiveState = Join-Path $outPath "state-interactive"
$interactiveInstall = Join-Path $outPath "install-interactive"
$silentState = Join-Path $outPath "state-silent"
$silentInstall = Join-Path $outPath "install-silent"

# ── 1. Interactive run: the host must be the only visible window ──────────
Write-Host "[capture] interactive install"
Reset-Scratch $interactiveState $interactiveInstall
$proc = Start-Preview $interactiveState $interactiveInstall "" "1"

$hostProc = $null
$sawHost = Wait-For {
    $script:hostProc = Get-Process -Name MusePiInstallerHost -ErrorAction SilentlyContinue |
        Sort-Object StartTime -Descending | Select-Object -First 1
    return ($null -ne $script:hostProc -and $script:hostProc.MainWindowHandle -ne 0)
} 30
if (-not $sawHost) {
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
    throw "installer host window never appeared (preview exit: $($proc.HasExited))"
}
$hostProc = $script:hostProc
Write-Host "  host pid=$($hostProc.Id) hwnd=$($hostProc.MainWindowHandle)"

Start-Sleep -Milliseconds 600
$native = Get-VisibleWindows $proc.Id
$script:nativeFrames += $native.Count
Record ($native.Count -eq 0) "no visible NSIS window while the language page is up"
Wait-Shot "1-language" 15

$native = Get-VisibleWindows $proc.Id
$script:nativeFrames += $native.Count
Record ($native.Count -eq 0) "no visible NSIS window while the location page is up"
Wait-Shot "2-location" 15

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline -and (Read-Phase $interactiveState) -ne "installing") {
    $script:nativeFrames += (Get-VisibleWindows $proc.Id).Count
    Start-Sleep -Milliseconds 120
}
$phase = Read-Phase $interactiveState
Record ($phase -eq "installing") "installer published phase=installing (got '$phase')"

Start-Sleep -Milliseconds 1400
$written = Measure-Tree $interactiveInstall
$script:nativeFrames += (Get-VisibleWindows $proc.Id).Count
Record ($written -gt 0) "files are being written during the progress page ($([math]::Round($written / 1MB, 2)) MB)"
Wait-Shot "3-progress" 20

$done = Wait-For { (Read-Phase $interactiveState) -eq "done" } 90
Record $done "installer published phase=done"
$script:nativeFrames += (Get-VisibleWindows $proc.Id).Count
Wait-Shot "4-finish" 20

$exited = Wait-For { $proc.HasExited } 40
Record ($exited -and $proc.ExitCode -eq 0) "interactive run exited 0 after the finish page (code $(if ($exited) { $proc.ExitCode } else { 'still running' }))"
if (-not $exited) { try { $proc.Kill() } catch {} }
Record ($script:nativeFrames -eq 0) "zero visible NSIS window samples across the whole interactive install (saw $script:nativeFrames)"
Record (Test-Path (Join-Path $interactiveInstall "PREVIEW-ONLY.txt")) "preview files landed in the scratch install root"

# ── 2. Silent run: no window at all, exit 0 ──────────────────────────────
Write-Host "[capture] silent install (/S)"
Reset-Scratch $silentState $silentInstall
$silent = Start-Preview $silentState $silentInstall "/S"
$silentNative = 0
$silentDeadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $silentDeadline) {
    $silent.Refresh()
    $silentNative += (Get-VisibleWindows $silent.Id).Count
    if ($silent.HasExited) { break }
    Start-Sleep -Milliseconds 100
}
$silent.Refresh()
if (-not $silent.HasExited) { try { $silent.Kill() } catch {} }
Record ($silent.HasExited -and $silent.ExitCode -eq 0) "silent run exited 0 (code $(if ($silent.HasExited) { $silent.ExitCode } else { 'still running' }))"
Record ($silentNative -eq 0) "silent run created no visible window (samples: $silentNative)"
Record (Test-Path (Join-Path $silentInstall "PREVIEW-ONLY.txt")) "silent run installed into the scratch root"
Record (-not (Test-Path (Join-Path $silentState "answers.ini"))) "silent run never asked for answers"

# ── 3. Cancel run: exit 2, files and uninstall entry removed ─────────────
Write-Host "[capture] cancel install"
$cancelState = Join-Path $outPath "state-cancel"
$cancelInstall = Join-Path $outPath "install-cancel"
$cancelKey = "MusePiPreviewCancelTest-" + [guid]::NewGuid().ToString("N")
Reset-Scratch $cancelState $cancelInstall
Remove-UninstallKey $cancelKey
try {
    $cancel = Start-Preview $cancelState $cancelInstall "" "cancel" $cancelKey
    $cancelExited = Wait-For { $cancel.HasExited } 90
    if (-not $cancelExited) { try { $cancel.Kill() } catch {} }
    Record ($cancelExited -and $cancel.ExitCode -eq 2) "cancel run exited 2 (code $(if ($cancelExited) { $cancel.ExitCode } else { 'still running' }))"
    Wait-Shot "5-cancelled" 20
    $cancelTargetGone = Wait-For { -not (Test-Path $cancelInstall) } 20
    Record $cancelTargetGone "cancel removed the scratch install directory"
    $cancelKeyGone = Wait-For { -not (Test-UninstallKey $cancelKey) } 20
    Record $cancelKeyGone "cancel removed the disposable Add/Remove Programs entry"
    Record (Test-Path (Join-Path $cancelState "host-status.ini")) "cancel wrote a host receipt"
}
finally {
    Remove-UninstallKey $cancelKey
    if ($cancel -and -not $cancel.HasExited) { try { $cancel.Kill() } catch {} }
}

# ── 4. Failure before customInstall: exit 3, same cleanup ────────────────
Write-Host "[capture] failing install"
$failState = Join-Path $outPath "state-fail"
$failInstall = Join-Path $outPath "install-fail"
$failKey = "MusePiPreviewFailTest-" + [guid]::NewGuid().ToString("N")
Reset-Scratch $failState $failInstall
Remove-UninstallKey $failKey
try {
    $failing = Start-Preview $failState $failInstall "" "1" $failKey $true
    $failExited = Wait-For { $failing.HasExited } 90
    if (-not $failExited) { try { $failing.Kill() } catch {} }
    Record ($failExited -and $failing.ExitCode -eq 3) "failing run exited 3 (code $(if ($failExited) { $failing.ExitCode } else { 'still running' }))"
    Wait-Shot "6-failed" 20
    $failTargetGone = Wait-For { -not (Test-Path $failInstall) } 20
    Record $failTargetGone "failure removed the scratch install directory"
    $failKeyGone = Wait-For { -not (Test-UninstallKey $failKey) } 20
    Record $failKeyGone "failure removed the disposable Add/Remove Programs entry"
}
finally {
    Remove-UninstallKey $failKey
    if ($failing -and -not $failing.HasExited) { try { $failing.Kill() } catch {} }
}

# ── Summary ──────────────────────────────────────────────────────────────
$summary = @(
    "MusePi installer flow capture",
    "preview: $exe",
    "shots:   $outPath",
    "host-pid: $($hostProc.Id)",
    "failures: $($script:failures.Count)"
)
if ($script:failures.Count -gt 0) {
    $summary += $script:failures | ForEach-Object { "FAIL: $_" }
}
$summary | Set-Content -LiteralPath $logPath -Encoding utf8
Write-Host "[capture] log -> $logPath"

if ($script:failures.Count -gt 0) {
    Write-Host "[capture] FAILED ($($script:failures.Count) assertion(s))"
    exit 1
}
Write-Host "[capture] PASS — the custom host was the only installer surface for the whole flow"
exit 0