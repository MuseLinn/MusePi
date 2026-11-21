#!/usr/bin/env python3
"""Build a runnable MusePi installer-flow preview (double-click to inspect).

Why this exists: a real `electron-builder --win nsis` pass needs a staged
`vendor/daemon/musepi.exe` and a full renderer build. This compiles the
**production** branding include with the production install timing into a tiny
standalone setup.exe, so the whole flow — host questions, silent install,
published phases, finish page — can be walked through and captured immediately.

The preview installs a few placeholder files into a scratch directory and
touches nothing else: no registry, no shortcuts, no uninstaller.

Usage:
    python apps/desktop/scripts/build-installer-preview.py
Output:
    apps/desktop/release/MusePi-installer-preview.exe
    (the installer host must be built first: node scripts/build-installer-host.mjs)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = APP_DIR / "build"
HARNESS = APP_DIR / "installer" / "preview" / "installer-preview.nsi"
HOST_EXE = APP_DIR / "installer" / "dist" / "MusePiInstallerHost.exe"
OUTPUT = APP_DIR / "release" / "MusePi-installer-preview.exe"


def find_makensis() -> Path | None:
    if env := os.environ.get("MAKENSIS"):
        path = Path(env)
        return path if path.is_file() else None
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


def main() -> int:
    makensis = find_makensis()
    if makensis is None:
        print("makensis not found", file=sys.stderr)
        return 1
    if not HOST_EXE.is_file():
        print(
            f"installer host missing: {HOST_EXE}\n"
            "  run `node scripts/build-installer-host.mjs` first — the preview launch "
            "path refuses to compile without the real host binary",
            file=sys.stderr,
        )
        return 1
    if not HARNESS.is_file():
        print(f"preview harness missing: {HARNESS}", file=sys.stderr)
        return 1

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            str(makensis),
            "/V2",
            "/INPUTCHARSET",
            "UTF8",
            f"-DPROJECT_DIR={APP_DIR}",
            f"-DBUILD_RESOURCES_DIR={BUILD_DIR}",
            f"-DOUTDIR={OUTPUT.parent}",
            str(HARNESS),
        ],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        print("[installer-preview] FAILED", file=sys.stderr)
        print(output, file=sys.stderr)
        return 1

    if not OUTPUT.is_file():
        print(f"[installer-preview] build reported success but {OUTPUT} is missing", file=sys.stderr)
        return 1

    size_mb = OUTPUT.stat().st_size / (1024 * 1024)
    print(f"[installer-preview] OK  {OUTPUT}")
    print(f"  size: {size_mb:.2f} MB")
    print("  double-click to walk the flow — installs only preview placeholder files to a scratch dir")
    print("  capture: pwsh -File apps/desktop/scripts/capture-installer-pages.ps1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())