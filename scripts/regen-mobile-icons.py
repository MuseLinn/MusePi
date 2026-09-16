# Regenerate MusePi Android (Capacitor) brand assets from the dot-matrix pi anchor.
#
# Brand constants and renderers are imported from scripts/regen-brand-icons.py
# (single source of truth). The vector XML layers in res/ are hand-maintained
# with the same geometry; this script renders every PNG the manifest/theme reads:
#   mipmap-*/ic_launcher.png             legacy full-tile icon (rounded square)
#   mipmap-*/ic_launcher_round.png       circular-masked variant
#   mipmap-*/ic_launcher_foreground.png  transparent pi glyph on the 108dp layer
#   drawable(-land|-port)-*/splash.png   full-screen gradient + centered mark
# and (with --preview) a self-contained QA page under .workbuddy/brand-qa/.
#
# Pi anatomy on the 64 grid (FAV_PATH_64): bar 36x8 (y 10..18), left leg flush
# 14..22, right leg inset 34..42, 8-unit right overhang — total 36x44. The
# adaptive foreground places the glyph 1:1 into the 108dp viewport (36x44 units
# translated to (36,32)-(72,76)), so the vector and the PNGs share one geometry
# and the glyph stays inside the 66dp safe zone (stroke-incl. bbox ~39x47).
#
# Splash keeps the plain gradient + mark: the anchor's dot texture lives on the
# tile, not on a full screen (screen-scale dots read as display noise).
#
# Usage:
#   python scripts/regen-mobile-icons.py            # write all res PNGs
#   python scripts/regen-mobile-icons.py --preview  # also write the QA page
#
# Requires: Pillow (repo policy: install into the managed venv).
from __future__ import annotations

import argparse
import base64
import importlib.util
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# regen-brand-icons.py hyphenates its filename, so it is not importable as a
# normal module — load it by path instead (keeps the constants single-source).
_BRAND = Path(__file__).resolve().parent / "regen-brand-icons.py"
_spec = importlib.util.spec_from_file_location("_musepi_brand_icons", _BRAND)
_brand = importlib.util.module_from_spec(_spec)
sys.modules["_musepi_brand_icons"] = _brand
_spec.loader.exec_module(_brand)

BG_BOTTOM = _brand.BG_BOTTOM
BG_TOP = _brand.BG_TOP
FAV_PATH_64 = _brand.FAV_PATH_64
FAV_STROKE_64 = _brand.FAV_STROKE_64
GLYPH = _brand.GLYPH
SS = _brand.SS
render_mark = _brand.render_mark

REPO = Path(__file__).resolve().parents[1]
RES = REPO / "packages" / "mobile" / "android" / "app" / "src" / "main" / "res"
QA_DIR = REPO / ".workbuddy" / "brand-qa"

DENSITIES = (("mdpi", 1.0), ("hdpi", 1.5), ("xhdpi", 2.0), ("xxhdpi", 3.0), ("xxxhdpi", 4.0))
LAUNCHER_DP = 48  # legacy launcher tile: 48dp
FG_LAYER_DP = 108  # adaptive foreground/background layer canvas: 108dp
GLYPH_W_UNITS = 36.0  # pi width on the 64 grid (x 14..50)
GLYPH_H_UNITS = 44.0  # pi height on the 64 grid (y 10..54)
SPLASH_GLYPH_FRAC = 0.20  # mark height vs splash short edge

# folder -> (w, h); matches the density layout already in res/
SPLASH_SIZES = {
	"drawable": (480, 320),  # mdpi default — the one AppTheme.NoActionBarLaunch points at
	"drawable-land-mdpi": (480, 320),
	"drawable-land-hdpi": (800, 480),
	"drawable-land-xhdpi": (1280, 720),
	"drawable-land-xxhdpi": (1600, 960),
	"drawable-land-xxxhdpi": (1920, 1280),
	"drawable-port-mdpi": (320, 480),
	"drawable-port-hdpi": (480, 800),
	"drawable-port-xhdpi": (720, 1280),
	"drawable-port-xxhdpi": (960, 1600),
	"drawable-port-xxxhdpi": (1280, 1920),
}


def gradient_rect(w: int, h: int) -> Image.Image:
	"""Full-bleed vertical gradient in the anchor palette."""
	img = Image.new("RGB", (w, h))
	gd = ImageDraw.Draw(img)
	for y in range(h):
		t = y / max(1, h - 1)
		c = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
		gd.line([(0, y), (w, y)], fill=c)
	return img


def glyph_img(height_px: int) -> Image.Image:
	"""Transparent pi silhouette rendered at the given glyph height."""
	height_px = max(1, round(height_px))
	scale = height_px * SS / GLYPH_H_UNITS
	# glyph bbox (14,10)-(50,54) plus the 1.5-unit stroke bleed → 39x47 canvas
	cw, ch = round(39 * scale), round(47 * scale)
	img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
	draw = ImageDraw.Draw(img)
	# stroke seam on pts[0] — rotate it onto the reflex vertex (42,18) so the
	# butt-cap notch hides inside the leg gap instead of notching a corner
	rotated = FAV_PATH_64[3:] + FAV_PATH_64[:3]
	pts = [((x - 12.5) * scale, (y - 8.5) * scale) for x, y in rotated]
	draw.polygon(pts, fill=GLYPH + (255,))
	draw.line(pts + [pts[0]], fill=GLYPH + (255,), width=max(1, round(FAV_STROKE_64 * scale)), joint="curve")
	out_w = max(1, round(39 * height_px / GLYPH_H_UNITS))
	out_h = max(1, round(47 * height_px / GLYPH_H_UNITS))
	return img.resize((out_w, out_h), Image.LANCZOS)


def circle_mask(img: Image.Image) -> Image.Image:
	mask = Image.new("L", img.size, 0)
	ImageDraw.Draw(mask).ellipse([0, 0, img.size[0] - 1, img.size[1] - 1], fill=255)
	out = Image.new("RGBA", img.size, (0, 0, 0, 0))
	out.paste(img, (0, 0), mask)
	return out


def rounded_mask(img: Image.Image, radius_frac: float) -> Image.Image:
	w, h = img.size
	mask = Image.new("L", img.size, 0)
	ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=round(min(w, h) * radius_frac), fill=255)
	out = Image.new("RGBA", img.size, (0, 0, 0, 0))
	out.paste(img, (0, 0), mask)
	return out


def launcher_tile(size: int) -> Image.Image:
	"""Legacy full-tile launcher icon: rounded gradient square + pi."""
	return render_mark(size)


def launcher_round(size: int) -> Image.Image:
	return circle_mask(render_mark(size))


def launcher_foreground(size: int) -> Image.Image:
	"""Adaptive foreground layer: pi centered on a transparent 108dp canvas."""
	g = glyph_img(size * GLYPH_H_UNITS / FG_LAYER_DP)
	out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	out.paste(g, ((size - g.width) // 2, (size - g.height) // 2), g)
	return out


def splash(w: int, h: int) -> Image.Image:
	img = gradient_rect(w, h).convert("RGBA")
	g = glyph_img(min(w, h) * SPLASH_GLYPH_FRAC)
	img.paste(g, ((w - g.width) // 2, (h - g.height) // 2), g)
	return img


def adaptive_composite(size: int, mask: str) -> Image.Image:
	"""What the launcher shows: gradient background + foreground, then mask."""
	bg = gradient_rect(size, size).convert("RGBA")
	g = glyph_img(size * GLYPH_H_UNITS / FG_LAYER_DP)
	bg.paste(g, ((size - g.width) // 2, (size - g.height) // 2), g)
	if mask == "circle":
		return circle_mask(bg)
	if mask == "squircle":
		return rounded_mask(bg, 0.24)
	return rounded_mask(bg, 0.1875)  # legacy-style rounded square (12/64)


def _b64(img: Image.Image) -> str:
	buf = io.BytesIO()
	img.save(buf, format="PNG")
	return base64.b64encode(buf.getvalue()).decode()


def write_preview() -> None:
	"""Self-contained QA page: masks, density ladder, splash, status bar."""
	def uri(img: Image.Image) -> str:
		return f"data:image/png;base64,{_b64(img)}"

	cards: list[str] = []

	def card(img: Image.Image, box: int, caption: str, dark: bool = False) -> None:
		bg = "#272729" if dark else "#ffffff"
		data = uri(img)
		cards.append(
			f'<figure style="background:{bg}">'
			f'<img src="{data}" style="width:{box}px" alt="{caption}">'
			f"<figcaption>{caption}</figcaption></figure>"
		)

	# adaptive icon under the three common masks + safe-zone overlay
	for mask, label in (("circle", "圆形 mask"), ("squircle", "方圆 mask"), ("rounded", "旧版圆角")):
		img = adaptive_composite(432, mask)
		if mask != "rounded":
			overlay = ImageDraw.Draw(img)
			r = 432 * 66 / 108 / 2
			overlay.ellipse([216 - r, 216 - r, 216 + r, 216 + r], outline=(255, 82, 82, 255), width=3)
			label += " · 66dp 安全区"
		card(img, 180, label, dark=True)

	# legacy density ladder
	for name, mult in DENSITIES:
		card(launcher_tile(round(LAUNCHER_DP * mult)), round(LAUNCHER_DP * mult), f"ic_launcher · {name}")
	for name, mult in DENSITIES:
		card(launcher_round(round(LAUNCHER_DP * mult)), round(LAUNCHER_DP * mult), f"round · {name}")
	card(launcher_foreground(432), 180, "ic_launcher_foreground · 108dp 层", dark=True)

	# splash previews (downscaled real renders)
	port = splash(720, 1280).resize((220, 391), Image.LANCZOS)
	land = splash(1280, 720).resize((312, 176), Image.LANCZOS)
	card(port, 220, "splash · 竖屏 720×1280", dark=True)
	card(land, 312, "splash · 横屏 1280×720", dark=True)

	# status-bar notification glyph sim (ic_stat_musepi geometry)
	bar = Image.new("RGBA", (360, 56), (0x11, 0x11, 0x13, 255))
	stat = glyph_img(44)
	white = Image.new("RGBA", stat.size, (255, 255, 255, 255))
	stat_white = Image.new("RGBA", stat.size, (0, 0, 0, 0))
	stat_white.paste(white, (0, 0), stat)
	bar.paste(stat_white, (24, 6), stat_white)
	bar.paste(stat_white, (320, 10), stat_white)
	card(bar, 360, "ic_stat_musepi · 状态栏模拟", dark=True)

	html = (
		"<!doctype html><html><head><meta charset='utf-8'>"
		"<title>MusePi 安卓图标 · 品牌统一预览</title><style>"
		"body{font-family:system-ui,sans-serif;background:#f5f5f7;margin:24px;color:#1d1d1f}"
		"h1{font-size:22px;letter-spacing:-0.3px}h2{font-size:15px;margin-top:28px;color:#555}"
		".row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}"
		"figure{margin:0;padding:12px;border-radius:12px;border:1px solid #e0e0e0;display:flex;"
		"flex-direction:column;align-items:center;gap:8px}"
		"figcaption{font-size:11px;color:#7a7a7a;text-align:center;max-width:180px}"
		"</style></head><body><h1>MusePi 安卓图标 · 点阵 π 品牌统一预览</h1>"
		"<p>scripts/regen-mobile-icons.py 生成 · 全部为真实渲染位图</p>"
		"<h2>自适应图标（66dp 安全区叠加）</h2><div class='row'>" + "".join(cards[0:3]) + "</div>"
		"<h2>旧版密度阶梯（48dp 基准）</h2><div class='row'>" + "".join(cards[3:13]) + "</div>"
		"<h2>前景层与启动页</h2><div class='row'>" + "".join(cards[13:]) + "</div>"
		"</body></html>"
	)
	QA_DIR.mkdir(parents=True, exist_ok=True)
	out = QA_DIR / "mobile-preview.html"
	out.write_text(html, encoding="utf-8")
	print(f"preview -> {out}")


def main() -> None:
	ap = argparse.ArgumentParser()
	ap.add_argument("--preview", action="store_true", help="also write the QA preview page")
	args = ap.parse_args()

	for name, mult in DENSITIES:
		d = RES / f"mipmap-{name}"
		d.mkdir(parents=True, exist_ok=True)
		tile = round(LAUNCHER_DP * mult)
		fg = round(FG_LAYER_DP * mult)
		launcher_tile(tile).save(d / "ic_launcher.png")
		launcher_round(tile).save(d / "ic_launcher_round.png")
		launcher_foreground(fg).save(d / "ic_launcher_foreground.png")
		print(f"mipmap-{name}: tile/round {tile}px, foreground {fg}px")
	for folder, (w, h) in SPLASH_SIZES.items():
		(RES / folder).mkdir(parents=True, exist_ok=True)
		splash(w, h).save(RES / folder / "splash.png")
		print(f"{folder}/splash.png {w}x{h}")
	if args.preview:
		write_preview()


if __name__ == "__main__":
	main()
