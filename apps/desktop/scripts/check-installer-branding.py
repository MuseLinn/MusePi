#!/usr/bin/env python3
"""Compile-check the MusePi Windows installer branding without packaging.

Runs makensis over `test/installer-branding-compile-check.nsi`, which mirrors
electron-builder's real contract:

  * defines electron-builder injects (PROJECT_DIR / BUILD_RESOURCES_DIR /
    PRODUCT_NAME / VERSION / APP_FILENAME)
  * page-before-language-before-LangString ordering
  * the customHeader call site and the .onInit -> customInit startup path

The script is fed through **stdin with -INPUTCHARSET UTF8**, exactly how
electron-builder invokes makensis (NsisTarget.js `executeMakensis`). That is
also why the .nsh files need no UTF-8 BOM — feeding them from disk instead
would make makensis guess the encoding and fail with "Bad text encoding".

Why a compile check and not a full build: a real `electron-builder --win`
pass needs the staged `vendor/daemon/musepi.exe` and a full renderer build.
This gate catches the failures that actually break installers — a missing
LangString, a stale bitmap path, a macro defined after its !ifmacrodef, a
bitmap that is not 24-bit — in about two seconds.

Usage:
    python apps/desktop/scripts/check-installer-branding.py
Exit codes: 0 ok, 1 compile failure or missing asset.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = APP_DIR / "build"
RELEASE_DIR = APP_DIR / "release"
BRANDING = RELEASE_DIR / "installer-branding.nsh"
SHORTCUTS = RELEASE_DIR / "ensure-shortcuts.nsh"
UI_DIR = APP_DIR / "installer" / "ui"
PREVIEW = APP_DIR / "installer" / "preview" / "installer-preview.nsi"
CAPTURE = APP_DIR / "scripts" / "capture-installer-pages.ps1"
HARNESS = APP_DIR / "test" / "installer-branding-compile-check.nsi"

# MUI reads these as 24-bit BMPs at fixed pixel sizes; a wrong size or a
# 32-bit/alpha image silently falls back to stock art instead of erroring.
REQUIRED_ASSETS = {
    "installerSidebar.bmp": (164, 314),
    "uninstallerSidebar.bmp": (164, 314),
    "installerHeader.bmp": (150, 57),
}


def find_makensis() -> Path | None:
    """Locate the makensis electron-builder downloads into its cache."""
    if env := os.environ.get("MAKENSIS"):
        candidate = Path(env)
        return candidate if candidate.is_file() else None

    if found := shutil.which("makensis"):
        return Path(found)

    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        # electron-builder unpacks NSIS in more than one layout across versions
        # (<Cache>/nsis/nsis-*/Bin and <Cache>/nsis-*/nsis-*), so search the tree.
        cache = Path(local_appdata) / "electron-builder" / "Cache"
        matches = sorted(cache.glob("**/makensis.exe"))
        if matches:
            return matches[-1]
    return None


def check_assets() -> list[str]:
    """Verify the bitmaps exist at the exact size and depth MUI expects."""
    problems: list[str] = []
    try:
        from PIL import Image
    except ImportError:
        return ["Pillow is required to validate installer bitmaps: pip install Pillow"]

    for name, expected in REQUIRED_ASSETS.items():
        path = BUILD_DIR / name
        if not path.is_file():
            problems.append(f"missing bitmap: {path.relative_to(APP_DIR)} (run gen-installer-assets.py)")
            continue
        with Image.open(path) as image:
            if image.size != expected:
                problems.append(f"{name}: expected {expected[0]}x{expected[1]}, got {image.size[0]}x{image.size[1]}")
            if image.mode != "RGB":
                problems.append(f"{name}: expected 24-bit RGB, got mode {image.mode}")
    return problems


def check_bom() -> list[str]:
    """NSIS scripts must stay BOM-free; electron-builder feeds them as UTF-8 stdin."""
    problems: list[str] = []
    for script in sorted(RELEASE_DIR.glob("*.nsh")):
        if script.read_bytes().startswith(b"\xef\xbb\xbf"):
            problems.append(
                f"{script.name}: unexpected UTF-8 BOM "
                "(electron-builder passes scripts via stdin with -INPUTCHARSET UTF8)"
            )
    return problems


def check_builder_wiring() -> list[str]:
    """The release config must load the WebView2 wizard, not only its shortcut helper."""
    package = json.loads((APP_DIR / "package.json").read_text(encoding="utf-8"))
    include = package.get("build", {}).get("nsis", {}).get("include")
    if include != "release/installer-branding.nsh":
        return [f"build.nsis.include must be release/installer-branding.nsh, got {include!r}"]
    return []


def check_flow_contract() -> list[str]:
    """The host must drive the whole install; no native page may ever be created.

    This is the static half of the regression gate: the runtime half lives in
    capture-installer-pages.ps1, which asserts that the installer process has no
    visible window for the whole run. These assertions name the mechanism, so a
    refactor that quietly drops the silent switch or the finish handshake fails
    here before anyone packages an installer.
    """
    problems: list[str] = []
    branding = BRANDING.read_text(encoding="utf-8")
    shortcuts = SHORTCUTS.read_text(encoding="utf-8")

    # Order matters inside customInit: ask → apply answers → go silent, all
    # before any page exists. Positions are taken inside the macro body so
    # function definitions elsewhere in the file cannot mask the real order.
    macro = branding.find("!macro customInit")
    macro_end = branding.find("!macroend", macro)
    body = branding[macro:macro_end] if macro >= 0 else ""
    stages = ["MuseWaitForHostDecision", "MuseApplyHostAnswers", "SetSilent silent"]
    positions = [body.find(stage) for stage in stages]
    if not body:
        problems.append("installer-branding.nsh: customInit macro not found")
    elif any(position < 0 for position in positions):
        missing = [stage for stage, position in zip(stages, positions) if position < 0]
        problems.append(f"installer-branding.nsh: customInit is missing {missing}")
    elif positions != sorted(positions):
        problems.append("installer-branding.nsh: SetSilent must run after the answers are applied")

    if "HideWindow" not in branding:
        problems.append(
            "installer-branding.nsh: HideWindow missing — the installer window could flash "
            "before the host takes over"
        )
    for argument in ("--status", "--installer-pid", "--answers"):
        if argument not in branding:
            problems.append(f"installer-branding.nsh: host is not launched with {argument}")

    for mutex in ("MusePi.Installer.Setup", "MusePi.Installer.Host"):
        if mutex not in branding:
            problems.append(f"installer-branding.nsh: liveness mutex {mutex} is not shared with the host")

    # System::Call's `.rN` writes $N (user variable), not $RN (register). Reading
    # the register instead leaves the probe stuck on a stale nonzero value, and
    # the installer then never exits after the finish page (a 30-minute invisible
    # hang caught by the real run).
    if "p .r1 ?e" in branding and "${If} $1 != 0" not in branding:
        problems.append(
            "installer-branding.nsh: MuseHostAlive must read $1 — System::Call .r1 does not write $R1"
        )

    macro = shortcuts.find("!macro customInstall")
    macro_end = shortcuts.find("!macroend", macro)
    body = shortcuts[macro:macro_end] if macro >= 0 else ""
    if not body:
        problems.append("ensure-shortcuts.nsh: customInstall macro not found")
    elif "MusePhase \"done\"" not in body or "MuseHostAlive" not in body:
        problems.append(
            "ensure-shortcuts.nsh: customInstall must publish phase=done and wait for the host; "
            "without it the host never learns the install finished"
        )

    # The preview define may only bypass the real desktop/start-menu writes.
    guard = body.find("!ifndef MUSE_INSTALLER_PREVIEW")
    create = body.find("CreateShortCut")
    if guard < 0:
        problems.append("ensure-shortcuts.nsh: preview guard around shortcut creation is missing")
    elif create >= 0 and create < guard:
        problems.append("ensure-shortcuts.nsh: CreateShortCut runs before the preview guard")

    return problems


def check_progress_contract() -> list[str]:
    """The progress page must show phases and real bytes, never a fake percent."""
    problems: list[str] = []
    html = (UI_DIR / "index.html").read_text(encoding="utf-8")
    script = (UI_DIR / "installer.js").read_text(encoding="utf-8")
    locales = (UI_DIR / "installer-locales.js").read_text(encoding="utf-8")

    if 'id="bar"' not in html or 'aria-busy="true"' not in html:
        problems.append('installer/ui/index.html: #bar must be an indeterminate progressbar (aria-busy="true")')
    if "progress-percent" in html or "progress-percent" in script:
        problems.append("installer/ui: a percentage label is back — a silent file section cannot report one")
    if "btn-cancel" not in html:
        problems.append("installer/ui/index.html: progress page has no cancel action")
    for state in ("installed", "cancelled", "failed"):
        if f'case "{state}"' not in script:
            problems.append(f"installer/ui/installer.js: host state '{state}' is not rendered")
    if "bytesWritten" not in locales:
        problems.append("installer/ui/installer-locales.js: bytesWritten copy is missing")
    return problems


def check_preview_pipeline() -> list[str]:
    """The preview and its capture script are the runtime gate for native pages."""
    problems: list[str] = []
    if not PREVIEW.is_file():
        problems.append(f"preview harness missing: {PREVIEW.relative_to(APP_DIR)}")
    else:
        text = PREVIEW.read_text(encoding="utf-8")
        if "MUSE_INSTALLER_PREVIEW" not in text:
            problems.append("preview harness: MUSE_INSTALLER_PREVIEW is not defined (real shortcuts would be created)")
        if "installer-branding.nsh" not in text:
            problems.append("preview harness: does not include the production installer branding")

    if not CAPTURE.is_file():
        problems.append(f"capture script missing: {CAPTURE.relative_to(APP_DIR)}")
    else:
        text = CAPTURE.read_text(encoding="utf-8")
        if "Get-VisibleWindows" not in text or "IsWindowVisible" not in text:
            problems.append("capture script: does not check visible installer windows")
        if "phase=done" not in text and "install-status.ini" not in text:
            problems.append("capture script: does not wait for the published install phases")
    return problems


def compile_check(makensis: Path, *, uninstaller: bool = False) -> tuple[bool, str]:
    """Feed the harness through stdin exactly like electron-builder does."""
    defines = [
        f"-DPROJECT_DIR={APP_DIR}",
        f"-DBUILD_RESOURCES_DIR={BUILD_DIR}",
    ]
    if uninstaller:
        defines.append("-DBUILD_UNINSTALLER")
    script = HARNESS.read_text(encoding="utf-8")
    proc = subprocess.run(
        [str(makensis), "/V2", "/INPUTCHARSET", "UTF8", *defines, "-"],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    # A harness without WriteUninstaller legitimately emits warning 6020.
    fatal = [line for line in output.splitlines() if line.strip() and "6020" not in line and "warning" not in line.lower()]
    ok = proc.returncode == 0 and "6001:" not in output and "6010:" not in output
    return ok, "\n".join(fatal) if fatal else output.strip()


def main() -> int:
    problems = (
        check_assets()
        + check_bom()
        + check_builder_wiring()
        + check_flow_contract()
        + check_progress_contract()
        + check_preview_pipeline()
    )

    makensis = find_makensis()
    if makensis is None:
        problems.append(
            "makensis not found — install NSIS or run any electron-builder win build once "
            "(it caches NSIS under LOCALAPPDATA/electron-builder/Cache)"
        )
    else:
        for uninstaller in (False, True):
            ok, detail = compile_check(makensis, uninstaller=uninstaller)
            if not ok:
                phase = "uninstaller" if uninstaller else "installer"
                problems.append(f"makensis {phase} failed:\n{detail}")

    if problems:
        print("[installer-branding] FAILED", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"[installer-branding] OK  (makensis {makensis})")
    print(f"  assets: {', '.join(REQUIRED_ASSETS)}")
    print("  compile: welcome/finish/uninstall pages + zh_CN + en_US LangStrings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
