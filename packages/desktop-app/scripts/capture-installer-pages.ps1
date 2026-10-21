# Capture every page of the MusePi installer preview.
#
# The preview is launched with TEMP/TMP pointed at a clean directory: the
# install host's %TEMP% is not usable by NSIS on this machine ("Error writing
# temporary file"), which is also why a real electron-builder NSIS pass fails
# here at the uninstaller hand-off.
#
# Usage: pwsh -File packages/desktop-app/scripts/capture-installer-pages.ps1

param(
    [string]$OutDir = ".tmp\installer-shots",
    [string]$TempDir = ".tmp\nsis-preview-temp"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# scripts/ -> desktop-app/ -> packages/ -> repo root
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$exe = Join-Path $repo "packages\desktop-app\release\MusePi-installer-preview.exe"
if (-not (Test-Path $exe)) { throw "preview not built: $exe (run build-installer-preview.py)" }

$outPath = Join-Path $repo $OutDir
$tempPath = Join-Path $repo $TempDir
New-Item -ItemType Directory -Force -Path $outPath, $tempPath | Out-Null

$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = $exe
$si.UseShellExecute = $false
$si.EnvironmentVariables["TEMP"] = $tempPath
$si.EnvironmentVariables["TMP"] = $tempPath
$si.EnvironmentVariables["TMPDIR"] = $tempPath
$proc = [System.Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 3
$proc.Refresh()
if ($proc.HasExited) { throw "installer exited early (code $($proc.ExitCode)) — TEMP still unusable?" }

function Save-Shot([string]$name) {
    $prev = $proc.Refresh()
    $h = $proc.MainWindowHandle
    if ($h -eq 0) { Write-Warning "no window handle for $name"; return }
    [Cap]::ShowWindow($h, 9) | Out-Null
    [Cap]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 600
    $r = New-Object Cap+RECT
    [Cap]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [Cap]::PrintWindow($h, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $file = Join-Path $outPath "$name.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  saved $name.png (${w}x${hh})"
}

# NSIS wizard "Next" is control id 1 inside the dialog; SendMessage WM_COMMAND
# 1 (BN_CLICKED) advances without needing to locate pixel coordinates.
function Click-Next([string]$label) {
    $h = $proc.MainWindowHandle
    [Cap]::SendMessage($h, 0x0111, [IntPtr]1, [IntPtr]0) | Out-Null   # WM_COMMAND, IDOK
    Start-Sleep -Milliseconds 900
    Write-Host "  advanced -> $label"
}

Write-Host "[capture] welcome page"
Save-Shot "1-welcome"

Write-Host "[capture] directory page"
Click-Next "directory"
Save-Shot "2-directory"

Write-Host "[capture] install progress (short: preview writes one file)"
Click-Next "instfiles"
Save-Shot "3-progress"

# The preview's install section finishes almost instantly, so page 3 may already
# be the finish page. Advance once more only if the window still has a Next
# button; otherwise what we captured is the finish page itself.
Write-Host "[capture] finish page"
$h = $proc.MainWindowHandle
if ($h -ne 0) {
    $next = [Cap]::SendMessage($h, 0x0400 + 32, [IntPtr]0, [IntPtr]1) # BM_GETSTATE on IDOK is unreliable; just advance
    Click-Next "finish"
    Save-Shot "4-finish" 
}

try { $proc.Kill() } catch {}
Write-Host "[capture] done -> $outPath"
