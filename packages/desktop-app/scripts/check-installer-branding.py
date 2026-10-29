#!/usr/bin/env python3
"""Compile-check the MusePi Windows installer branding without packaging.

Runs makensis over `test/installer-branding-compile-check.nsi`, which mirrors
electron-builder's real contract:

  * defines electron-builder injects (PROJECT_DIR / BUILD_RESOURCES_DIR /
    PRODUCT_NAME / VERSION / APP_FILENAME)
  * page-before-language-before-LangString ordering
  * the !ifmacrodef call sites for customWelcomePage / customHeader

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
    python packages/desktop-app/scripts/check-installer-branding.py
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
        cache = Path(local_appdata) / "electron-builder" / "Cache"
        matches = sorted(cache.glob("nsis-*/**/Bin/makensis.exe"))
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
    problems = check_assets() + check_bom() + check_builder_wiring()

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
