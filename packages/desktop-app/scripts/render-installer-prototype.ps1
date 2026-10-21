# Render the MusePi installer liquid-glass prototype to PNG.
#
# Uses the installed Edge in headless mode: Edge IS the WebView2 engine, so the
# capture shows what the real installer host will composite (in particular
# `backdrop-filter`, which only appears when a real compositor paints).
#
# Two things this handles that a naive `--screenshot` call gets wrong:
#   1. The window has a 560ms entrance spring; capturing immediately catches it
#      mid-fade. `--virtual-time-budget` advances the clock so animations settle.
#   2. file:// subresources can fail silently; the prototype inlines its icon as
#      a data: URI so the render is self-contained.
#
# Usage: pwsh -File packages/desktop-app/scripts/render-installer-prototype.ps1
#   -Html <path>  -Out <path>  -Width 860  -Height 640  -Scale 2

param(
    [string]$Html = ".tmp\installer-prototype\liquid-glass.html",
    [string]$Out = ".tmp\installer-prototype\liquid-glass.png",
    [int]$Width = 860,
    [int]$Height = 640,
    [int]$Scale = 2
)

$ErrorActionPreference = "Stop"

$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$htmlPath = if ([System.IO.Path]::IsPathRooted($Html)) { $Html } else { Join-Path $repo $Html }
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repo $Out }

if (-not (Test-Path $htmlPath)) { throw "prototype not found: $htmlPath" }

$edgeCandidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found (needed as the WebView2 engine)" }

$outDir = Split-Path $outPath -Parent
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $outPath) { Remove-Item $outPath -Force }

$uri = ([System.Uri]$htmlPath).AbsoluteUri

# --virtual-time-budget lets CSS animations advance to completion before the
# frame is taken; without it the entrance opacity is still mid-transition.
& $edge `
    --headless=new `
    "--force-device-scale-factor=$Scale" `
    "--window-size=$Width,$Height" `
    "--virtual-time-budget=4000" `
    --hide-scrollbars `
    "--screenshot=$outPath" `
    $uri 2>&1 | Out-Null

if (-not (Test-Path $outPath)) { throw "screenshot was not produced: $outPath" }

$item = Get-Item $outPath
Write-Host "[render] $outPath"
Write-Host ("  {0:N1} KB" -f ($item.Length / 1KB))
