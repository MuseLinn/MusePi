#!/bin/bash
# Classify upstream-changed files into three states for porting.
#
# Usage: scripts/upstream-classify.sh <old-tag> <new-tag> [file-list]
#   file-list: file paths (one per line); defaults to the diff between tags
#
# Output (per file):
#   NEW|path            — file absent in musepi -> copy from new-tag + rename
#   PURE_UPSTREAM|path  — musepi == old-tag -> overwrite with new-tag + rename
#   THREE_WAY|path      — both sides changed -> git merge-file (base=old+rename,
#                          ours=musepi, theirs=new+rename), resolve leftovers
#   SAME|path           — identical in both tags and musepi -> skip
#   LOCAL_ONLY|path     — upstream unchanged, musepi diverged -> keep musepi
#   ALREADY|path        — musepi already == new-tag -> skip
#
# Environment: UPSTREAM_REPO (default ../oh-my-pi), MUSEPI_ROOT (default cwd)
set -euo pipefail

OLD_TAG="${1:?old-tag required (e.g. v17.2.1)}"
NEW_TAG="${2:?new-tag required (e.g. v17.2.2)}"
UP="${UPSTREAM_REPO:-$(cd "$(dirname "$0")/.." && pwd)/../oh-my-pi}"
MU="${MUSEPI_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

FILE_LIST="${3:-}"
if [ -z "$FILE_LIST" ]; then
  FILE_LIST=$(cd "$UP" && git diff --name-only "$OLD_TAG".."$NEW_TAG")
fi

echo "$FILE_LIST" | while read -r f; do
  [ -n "$f" ] || continue
  if [ ! -f "$MU/$f" ]; then echo "NEW|$f"; continue; fi
  base=$(cd "$UP" && git show "$OLD_TAG:$f" 2>/dev/null | md5 -q || true)
  tgt=$(cd "$UP" && git show "$NEW_TAG:$f" 2>/dev/null | md5 -q || true)
  mu=$(md5 -q "$MU/$f" 2>/dev/null || true)
  if [ "$base" = "$tgt" ]; then
    if [ "$mu" = "$base" ]; then echo "SAME|$f"; else echo "LOCAL_ONLY|$f"; fi
  else
    if [ "$mu" = "$base" ]; then echo "PURE_UPSTREAM|$f"
    elif [ "$mu" = "$tgt" ]; then echo "ALREADY|$f"
    else echo "THREE_WAY|$f"; fi
  fi
done
