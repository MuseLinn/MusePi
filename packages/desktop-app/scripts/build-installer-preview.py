#!/usr/bin/env python3
"""Build a runnable MusePi installer UI preview (double-click to inspect).

Why this exists: a real `electron-builder --win nsis` pass needs a staged
`vendor/daemon/musepi.exe` and a full renderer build, and on a machine where
the uninstaller hand-off fails it never produces a launchable wizard. This
compiles the **production** branding include into a tiny standalone setup.exe
so the wizard can be walked through immediately.

The preview installs one text file into a scratch directory and touches
nothing else — no registry, no shortcuts, no uninstaller.

Usage:
    python packages/desktop-app/scripts/build-installer-preview.py
Output:
    packages/desktop-app/release/MusePi-installer-preview.exe
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = APP_DIR / "build"
HARNESS = APP_DIR / "test" / "installer-preview.nsi"
OUTPUT = APP_DIR / "release" / "MusePi-installer-preview.exe"


def find_makensis() -> Path | None:
    if env := os.environ.get("MAKENSIS"):
        path = Path(env)
        return path if path.is_file() else None
    if found := shutil.which("makensis"):
        return Path(found)
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        matches = sorted((Path(local_appdata) / "electron-builder" / "Cache" / "nsis").glob("nsis-*/Bin/makensis.exe"))
        if matches:
            return matches[-1]
    return None


def main() -> int:
    makensis = find_makensis()
    if makensis is None:
        print("makensis not found", file=sys.stderr)
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
    print("  double-click to walk the wizard — installs only PREVIEW-ONLY.txt to a scratch dir")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
