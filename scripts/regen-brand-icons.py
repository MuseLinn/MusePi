# Regenerate MusePi brand icon assets from the dot-matrix pi anchor.
#
# The dot-matrix pi (packages/desktop-app/build/icon.svg, src/vendor/logo.png)
# is the brand anchor. This script derives the size-adaptive family:
#   - guest-client/public favicon set (favicon.svg is hand-written separately)
#   - Windows/macOS tray glyph bitmaps (base64, pasted into electron/tray.cjs)
#   - a visual QA sheet (light/dark taskbar simulation) under .workbuddy/
#
# Small sizes render the matrix "merged": solid rounded-join pi silhouette,
# same proportions as the dot grid (bar 3u deep, legs 3u wide, gap 8u on a
# 14x17u glyph). Large sizes add the faint matrix texture from the anchor.
# 180px (apple-touch-icon) is full-bleed: iOS masks corners itself and would
# otherwise paint black behind the transparent ones.
#
# Usage:
#   python scripts/regen-brand-icons.py            # write all assets
#   python scripts/regen-brand-icons.py --qa-only  # only render the QA sheet
#
# Requires: Pillow (repo policy: install into the managed venv).
from __future__ import annotations

import argparse
import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "packages" / "client-core" / "public"
QA_DIR = REPO / ".workbuddy" / "brand-qa"

# Anchor palette (from build/icon.svg).
BG_TOP = (0x24, 0x21, 0x28)
BG_BOTTOM = (0x1B, 0x19, 0x1F)
GLYPH = (0xEC, 0xE8, 0xE9)  # same off-white as the anchor's matrix dots
MATRIX_ALPHA = 0.09

# 64-grid favicon geometry: pi silhouette 36x44 centered (14,10)-(50,54),
# proportions inherited from the anchor matrix (bar 8 deep, legs 8 wide,
# gap 20). stroke_width 3 with round joins gives the dot-soft corners.
FAV_PATH_64 = [(14, 10), (50, 10), (50, 18), (42, 18), (42, 54), (34, 54), (34, 18), (22, 18), (22, 54), (14, 54)]
FAV_STROKE_64 = 3.0
FAV_CORNER_64 = 12.0  # rounded-square background radius
MATRIX_PITCH_64 = 1.5  # anchor dot pitch (24/1024 * 64)
MATRIX_R_64 = 0.2625  # anchor dot radius (4.2/1024 * 64)
MATRIX_SPAN_64 = (11.0, 53.0)  # faint texture zone

# 36-grid tray glyph (18pt @2x): pi 20x26 centered (8,5)-(28,31), bar 4 deep,
# legs 4 wide, gap 12 — same ratios as the favicon silhouette. Two frames:
# solid (unseen/busy) and hollow (idle) — Windows distinguishes tray state by
# frame shape, never alpha (partial alpha is unreliable in Shell_NotifyIcon).
TRAY_SIZE = 36
TRAY_PATH_36 = [(8, 5), (28, 5), (28, 9), (24, 9), (24, 31), (20, 31), (20, 9), (12, 9), (12, 31), (8, 31)]
TRAY_STROKE_36 = 2.4  # ~1.2px rounding at the 20px Windows size
TRAY_HOLLOW_STROKE_36 = 3.2  # ~1.8px outline at 20px — reads as a clear ring
SS = 8  # supersample factor for crisp small raster output

PNG_SIZES = [16, 32, 180, 192, 512]  # 180 = apple-touch (full bleed), 256 = favicon.png
ICO_SIZES = [16, 32, 48]


def bg_square(size: int, rounded: bool = True) -> Image.Image:
	"""Dark gradient square (anchor palette), optionally rounded corners."""
	img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	grad = Image.new("RGBA", (size, size))
	gd = ImageDraw.Draw(grad)
	for y in range(size):
		t = y / max(1, size - 1)
		c = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
		gd.line([(0, y), (size, y)], fill=c)
	if rounded:
		mask = Image.new("L", (size, size), 0)
		ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=round(FAV_CORNER_64 * size / 64), fill=255)
		img.paste(grad, (0, 0), mask)
	else:
		img.paste(grad, (0, 0))
	return img


def draw_texture(draw: ImageDraw.ImageDraw, scale: float) -> None:
	"""Faint matrix dots (anchor family texture)."""
	r = MATRIX_R_64 * scale
	lo, hi = MATRIX_SPAN_64
	n = int(round((hi - lo) / MATRIX_PITCH_64)) + 1
	color = GLYPH + (round(MATRIX_ALPHA * 255),)
	for iy in range(n):
		for ix in range(n):
			x = (lo + ix * MATRIX_PITCH_64) * scale
			y = (lo + iy * MATRIX_PITCH_64) * scale
			draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def render_mark(size: int, texture: bool | None = None, full_bleed: bool = False) -> Image.Image:
	"""Favicon mark at any pixel size (supersampled, LANCZOS down)."""
	if texture is None:
		texture = size >= 180
	ss = size * SS
	scale = ss / 64.0
	img = bg_square(ss, rounded=not full_bleed)
	draw = ImageDraw.Draw(img)
	if texture:
		draw_texture(draw, scale)
	# Solid silhouette with round joins: fill polygon + closed stroke.
	# Start the stroke at a reflex vertex (42,18): draw.line's butt seam lands
	# on pts[0], and on the convex top-left corner it leaves a visible notch.
	pts = [(x * scale, y * scale) for x, y in FAV_PATH_64[3:] + FAV_PATH_64[:3]]
	draw.polygon(pts, fill=GLYPH + (255,))
	draw.line(pts + [pts[0]], fill=GLYPH + (255,), width=max(1, round(FAV_STROKE_64 * scale)), joint="curve")
	return img.resize((size, size), Image.LANCZOS)


def render_tray(hollow: bool) -> Image.Image:
	"""36x36 black pi tray glyph (alpha shape; tray.cjs recolors RGB)."""
	ss = TRAY_SIZE * SS
	scale = ss / 36.0
	img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
	draw = ImageDraw.Draw(img)
	black = (0, 0, 0, 255)
	pts = [(x * scale, y * scale) for x, y in TRAY_PATH_36]
	if hollow:
		draw.line(pts + [pts[0]], fill=black, width=max(1, round(TRAY_HOLLOW_STROKE_36 * scale)), joint="curve")
	else:
		draw.polygon(pts, fill=black)
		draw.line(pts + [pts[0]], fill=black, width=max(1, round(TRAY_STROKE_36 * scale)), joint="curve")
	return img.resize((TRAY_SIZE, TRAY_SIZE), Image.LANCZOS)


def png_bytes(img: Image.Image) -> bytes:
	out = io.BytesIO()
	img.save(out, format="PNG")
	return out.getvalue()


def write_assets() -> None:
	for s in PNG_SIZES:
		if s == 180:
			render_mark(s, full_bleed=True).save(PUBLIC / f"favicon-{s}x{s}.png")
		else:
			render_mark(s).save(PUBLIC / f"favicon-{s}x{s}.png")
		print(f"wrote favicon-{s}x{s}.png")
	# classic favicon.png (256) kept at its legacy filename
	render_mark(256).save(PUBLIC / "favicon.png")
	print("wrote favicon.png (256)")

	per = {s: render_mark(s) for s in ICO_SIZES}
	ico_path = PUBLIC / "favicon.ico"
	per[ICO_SIZES[-1]].save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=[per[s] for s in ICO_SIZES])
	print("wrote favicon.ico (16/32/48)")

	for label, hollow in (("hollow", True), ("solid", False)):
		b64 = base64.b64encode(png_bytes(render_tray(hollow))).decode()
		out = REPO / f".tray-glyph-{label}.b64"
		out.write_text(b64)
		print(f"wrote {out.name} ({len(b64)} chars, 36x36, {'hollow' if hollow else 'solid'})")


def write_qa_sheet() -> None:
	"""QA sheet: favicon sizes, then tray simulation on dark and light taskbars."""
	QA_DIR.mkdir(parents=True, exist_ok=True)
	pad, cell = 16, 128
	row1_h = cell + pad * 2
	tray_h = 48
	W = pad * 6 + cell + 96 + 64 + 32 + 16
	H = row1_h + (tray_h + 8) * 2
	sheet = Image.new("RGBA", (W, H), (0xFA, 0xFA, 0xFA, 255))

	x = pad
	for s, box in ((512, cell), (192, 96), (64, 64), (32, 32), (16, 16)):
		mark = render_mark(s)
		if box != s:
			mark = mark.resize((box, box), Image.LANCZOS)
		sheet.paste(mark, (x, pad + (cell - box) // 2), mark)
		x += box + pad

	def tray_row(y: int, bar_rgb: tuple[int, int, int], glyph_rgb: tuple[int, int, int]) -> None:
		sheet.paste(Image.new("RGBA", (W, tray_h), bar_rgb + (255,)), (0, y))
		for k, hollow in enumerate((True, False)):
			img = render_tray(hollow).resize((20, 20), Image.LANCZOS)
			px = img.load()
			for j in range(20):
				for i in range(20):
					r, g, b, a = px[i, j]
					px[i, j] = (*glyph_rgb, a)
			sheet.paste(img, (pad + k * 32, y + 14), img)

	y = row1_h + 8
	tray_row(y, (0x20, 0x20, 0x20), (255, 255, 255))  # dark taskbar: idle(hollow) | unseen(solid)
	tray_row(y + tray_h + 8, (0xF3, 0xF3, 0xF3), (0x18, 0x18, 0x1B))  # light taskbar
	sheet.convert("RGB").save(QA_DIR / "brand-qa-sheet.png")
	print(f"QA sheet -> {QA_DIR / 'brand-qa-sheet.png'}")


def main() -> None:
	ap = argparse.ArgumentParser()
	ap.add_argument("--qa-only", action="store_true")
	args = ap.parse_args()
	if not args.qa_only:
		write_assets()
	write_qa_sheet()


if __name__ == "__main__":
	main()
