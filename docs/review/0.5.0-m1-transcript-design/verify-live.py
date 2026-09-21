"""M1 visual verification: boot mock-host + client-core dev server, join the
canned fixture session in a real browser, screenshot the transcript.

One-shot: spawns both children, waits for the join link, drives Playwright,
then kills the children. Nothing is left running.
"""
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PKG = Path(__file__).resolve().parents[3] / "packages" / "client-core"
BUN = os.path.expandvars(r"%USERPROFILE%/.bun/bin/bun.exe")
OUT = Path(__file__).parent / "shots" / "live"
OUT.mkdir(parents=True, exist_ok=True)

procs = []


def spawn(args):
    p = subprocess.Popen(
        args,
        cwd=PKG,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    procs.append(p)
    return p


def main():
    host = spawn([BUN, "scripts/mock-host.ts", "--port", "7467"])
    link = None
    t0 = time.time()
    buf = ""
    assert host.stdout is not None
    while time.time() - t0 < 30:
        line = host.stdout.readline()
        if not line:
            break
        buf += line
        m = re.search(r"join link: (\S+)", line)
        if m:
            link = m.group(1)
            break
    if not link:
        print("NO JOIN LINK\n", buf[-2000:])
        return 1
    print("join link:", link)

    # The whole collab link is the URL fragment (formatCollabLink emits
    # `ws://host/r/<room>.<key>` with no `#`); point it at the dev server.
    frag = link
    dev = spawn([BUN, "./index.html"])
    time.sleep(3)

    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
        pg.goto(f"http://localhost:3000/#{frag}")
        # Connect screen auto-reads the hash; wait for the transcript rows.
        try:
            pg.wait_for_selector(".tr-turn-head", timeout=25000)
        except Exception as e:
            print("turn header never appeared:", e)
            pg.screenshot(path=str(OUT / "debug.png"), full_page=True)
            b.close()
            return 1
        time.sleep(2.5)  # settle folds/streaming
        pg.screenshot(path=str(OUT / "transcript-live.png"), full_page=True)
        # Scroll to top to capture the first turn headers.
        pg.evaluate("window.scrollTo(0, 0)")
        time.sleep(0.8)
        pg.screenshot(path=str(OUT / "transcript-live-top.png"), full_page=True)
        # Toggle the first 活动 fold open if present.
        fold = pg.query_selector(".tr-round-fold")
        if fold:
            fold.click()
            time.sleep(0.8)
            pg.screenshot(path=str(OUT / "transcript-fold-open.png"), full_page=True)
        b.close()
    print("shots at", OUT)
    return 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        for p in procs:
            try:
                # CTRL_BREAK without CREATE_NEW_PROCESS_GROUP would hit our own
                # process group; plain kill (TerminateProcess) is scoped.
                p.kill()
                p.wait(timeout=5)
            except Exception:
                pass
    sys.exit(code)
