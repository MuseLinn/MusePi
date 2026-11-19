#!/usr/bin/env python3
"""Fail unless every job feeding the `CI required` gate succeeded.

`HEAVY` jobs may be skipped only when the `changes` gate reported no code
changes. Any other skipped, failed or cancelled dependency fails the gate, so a
job that never ran cannot look like a pass to branch protection.
"""

from __future__ import annotations

import json
import os
import sys

HEAVY = frozenset(
    {
        "rust_validate",
        "rust_platform_check",
        "native_addons_x64",
        "native_addons",
        "test_workspace",
        "test_coding_agent_singleton",
        "test_ts_native",
        "test_coding_agent_ui",
        "test_coding_agent_runtime",
        "test_coding_agent_native",
        "test_smoke",
        "test_desktop_smoke",
        "install_methods",
    }
)


def failures(needs: dict[str, dict[str, object]], code: bool) -> list[tuple[str, object]]:
    bad: list[tuple[str, object]] = []
    changes = needs.get("changes", {})
    if changes.get("result") != "success":
        bad.append(("changes", changes.get("result")))
    for job, entry in needs.items():
        if job == "changes":
            continue
        result = entry.get("result")
        if result == "success":
            continue
        if result == "skipped" and job in HEAVY and not code:
            continue
        bad.append((job, result))
    return bad


def main() -> int:
    needs = json.loads(os.environ["NEEDS"])
    code = str(needs.get("changes", {}).get("outputs", {}).get("code")) == "true"
    bad = failures(needs, code)
    if bad:
        for job, result in bad:
            print(f"::error title=CI required::{job}: {result}")
        return 1
    print("required checks passed" if code else "no code changes; heavy jobs skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
