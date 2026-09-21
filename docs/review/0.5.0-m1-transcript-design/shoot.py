import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).parent
html = (root / "mockup.html").resolve().as_uri()
out = root / "shots"
out.mkdir(exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 900}, device_scale_factor=2)
    pg.goto(html)
    pg.wait_for_timeout(600)

    # 整页长图
    pg.screenshot(path=str(out / "mockup-full.png"), full_page=True)

    # 分区截图（按 section 顺序）
    secs = pg.query_selector_all("section")
    labels = ["a-turn-collapsed-expanded", "b-loading-suppression", "c-tail-hook-rows", "d-streaming"]
    for i, sec in enumerate(secs):
        if i < len(labels):
            sec.screenshot(path=str(out / f"{labels[i]}.png"))
    b.close()
print("done", out)
