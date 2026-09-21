"""Batch A smoke: verify the back-to-bottom button appears on upscroll and
clicking it returns to the tail. Reuses the verify-live.py machinery."""
import os
import re
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
    p = subprocess.Popen(args, cwd=PKG, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8", errors="replace")
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

    spawn([BUN, "./index.html"])
    time.sleep(3)

    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
        pg.goto(f"http://localhost:3000/#{link}")
        pg.wait_for_selector(".tr-turn-head", timeout=25000)
        time.sleep(2)
        scroller = "document.querySelector('.tr-root')"
        # 1. Scroll up → the button must appear (released from following).
        pg.evaluate(f"({scroller}).scrollTo({{top: 0, behavior: 'instant'}})")
        time.sleep(0.6)
        btn = pg.query_selector(".tr-back-bottom")
        if not btn:
            print("FAIL: button did not appear after upscroll")
            pg.screenshot(path=str(OUT / "back-bottom-debug.png"), full_page=True)
            b.close()
            return 1
        pg.screenshot(path=str(OUT / "back-bottom-visible.png"), full_page=True)
        # 2. Click → smooth scroll back; following re-arms, button hides.
        btn.click()
        time.sleep(1.2)
        hidden = pg.query_selector(".tr-back-bottom") is None
        metrics = pg.evaluate(
            f"(() => {{ const s = {scroller}; return {{top: s.scrollTop, max: s.scrollHeight - s.clientHeight}}; }})()"
        )
        print("after click: button hidden =", hidden, "scroll:", metrics)
        pg.screenshot(path=str(OUT / "back-bottom-returned.png"), full_page=True)
        b.close()
        if not hidden or metrics["max"] - metrics["top"] > 60:
            print("FAIL: did not return to tail")
            return 1
    print("back-to-bottom OK")
    return 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        for p in procs:
            try:
                p.kill()
                p.wait(timeout=5)
            except Exception:
                pass
    sys.exit(code)
