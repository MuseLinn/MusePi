# Regenerate MusePi brand icon assets from the orb master in
# packages/desktop-app/build/.
#
# The SVG set there is the ONLY geometry source (icon.svg plus its size
# variants); this script never draws the mark itself. It shells out to
# scripts/render-brand-assets.mjs (Chrome headless) for the rasters, then does
# the parts Pillow is actually good at: flattening, masking, recolouring and
# container assembly. Output:
#   - client-core/public favicon set (the SVG favicon is hand-written)
#   - Windows/macOS tray glyph bitmaps (base64, pasted into electron/tray.cjs)
#   - a visual QA sheet (light/dark taskbar simulation) under .workbuddy/
#
# Size tiers — every pixel size is rendered from the master DRAWN for it, never
# downscaled from the 1024 sheet:
#   16/24/32  icon-mini-plain.svg  uncropped sphere, no headband/earcups
#   48/64/96  icon-mini.svg        uncropped sphere, full rig
#   128+      icon.svg             golden-ratio crop, full rig
# 180px (apple-touch-icon) is flattened onto the card colour: iOS masks the
# corners itself and would otherwise paint black behind the transparent ones.
#
# Usage:
#   python scripts/regen-brand-icons.py            # write all assets
#   python scripts/regen-brand-icons.py --qa-only  # only render the QA sheet
#
# Requires: Pillow (repo policy: install into the managed venv) + node for the
# headless render step.
from __future__ import annotations

import argparse
import base64
import io
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "packages" / "client-core" / "public"
RASTER = REPO / ".workbuddy" / "brand-qa" / "brand-png"
QA_DIR = REPO / ".workbuddy" / "brand-qa"
RENDER = REPO / "scripts" / "render-brand-assets.mjs"

# Card palette lifted from build/icon.svg (i-bg). BG_BOTTOM flattens the
# apple-touch-icon, which has to ship full-bleed; BG_TOP is the gradient's other
# end and is re-exported for the Android splash background.
BG_TOP = (0x24, 0x21, 0x28)
BG_BOTTOM = (0x1B, 0x19, 0x1F)

TRAY_SIZE = 36  # tray.cjs resizes to 20px on Windows; 36 = 18pt @2x
SS = 8  # supersample factor, kept for callers that import it

PNG_SIZES = [16, 32, 180, 192, 512]  # 180 = apple-touch (flattened); 256 = favicon.png
ICO_SIZES = [16, 24, 32, 48]


def ensure_rasters() -> None:
	"""Rasterise the masters through Chrome headless (idempotent, ~2s)."""
	if (RASTER / "tray-solid-36.png").exists() and all((RASTER / f"icon-{s}.png").exists() for s in ICO_SIZES):
		return
	subprocess.run(["node", str(RENDER), "--out", str(RASTER)], check=True, cwd=REPO)


def render_mark(size: int, full_bleed: bool = False) -> Image.Image:
	"""The mark at `size`, straight from that size's own master render."""
	img = Image.open(RASTER / f"icon-{size}.png").convert("RGBA")
	if full_bleed:
		flat = Image.new("RGBA", img.size, (*BG_BOTTOM, 255))
		img = Image.alpha_composite(flat, img)
	return img


def render_android_fg(size: int) -> Image.Image:
	"""Adaptive-icon foreground layer: card-less orb on transparency, 108dp grid."""
	return Image.open(RASTER / f"android-fg-{size}.png").convert("RGBA")


def render_android_mono(size: int) -> Image.Image:
	"""Themed-icon layer: sphere with the headband carved out, 108dp grid.

	Android tints this layer's alpha, so it has to be a shape. Pointing
	<monochrome> at the full-colour orb instead would render a tinted blob.
	"""
	return Image.open(RASTER / f"android-mono-{size}.png").convert("RGBA")


def render_stat(size: int = 24) -> Image.Image:
	"""Status-bar notification glyph, white on transparent (preview + QA).

	Same geometry as res/drawable/ic_stat_musepi.xml — that vector is GENERATED
	from build/ic_stat_musepi.xml, so the preview cannot drift from the layer.
	"""
	return Image.open(RASTER / f"stat-{size}.png").convert("RGBA")


def render_splash_orb(size: int = 512) -> Image.Image:
	return Image.open(RASTER / f"splash-orb-{size}.png").convert("RGBA")


def render_tray(hollow: bool) -> Image.Image:
	"""Monochrome tray glyph (black on transparent; tray.cjs recolours the RGB).

	Windows Shell_NotifyIcon cannot rely on partial alpha, so the two states are
	two SHAPES: solid = filled sphere with the headband carved out, hollow = ring.
	"""
	name = "tray-hollow" if hollow else "tray-solid"
	return Image.open(RASTER / f"{name}-{TRAY_SIZE}.png").convert("RGBA")


def png_bytes(img: Image.Image) -> bytes:
	out = io.BytesIO()
	img.save(out, format="PNG")
	return out.getvalue()


def write_ico(path: Path, entries: list[tuple[int, Image.Image]]) -> None:
	"""Hand-assembled ICO so every entry keeps its own master.

	Pillow's `sizes=[…]` path resamples ONE source for all entries, which is
	exactly the thing the size tiers exist to avoid.
	"""
	payloads = [(s, png_bytes(img)) for s, img in entries]
	header = struct.pack("<HHH", 0, 1, len(payloads))
	offset = len(header) + 16 * len(payloads)
	directory, blobs = b"", b""
	for s, data in payloads:
		dim = 0 if s >= 256 else s
		directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
		blobs += data
		offset += len(data)
	path.write_bytes(header + directory + blobs)


def write_assets() -> None:
	for s in PNG_SIZES:
		render_mark(s, full_bleed=(s == 180)).save(PUBLIC / f"favicon-{s}x{s}.png")
		print(f"wrote favicon-{s}x{s}.png")
	# classic favicon.png (256) kept at its legacy filename
	render_mark(256).save(PUBLIC / "favicon.png")
	print("wrote favicon.png (256)")

	write_ico(PUBLIC / "favicon.ico", [(s, render_mark(s)) for s in ICO_SIZES])
	print(f"wrote favicon.ico ({'/'.join(str(s) for s in ICO_SIZES)})")

	for label, hollow in (("hollow", True), ("solid", False)):
		b64 = base64.b64encode(png_bytes(render_tray(hollow))).decode()
		out = REPO / f".tray-glyph-{label}.b64"
		out.write_text(b64)
		print(f"wrote {out.name} ({len(b64)} chars, {TRAY_SIZE}x{TRAY_SIZE}, {'hollow' if hollow else 'solid'})")


def recolor(img: Image.Image, rgb: tuple[int, int, int], size: int = 20) -> Image.Image:
	"""Taskbar simulation: recolour the alpha shape, drop it at the Windows size."""
	small = img.resize((size, size), Image.LANCZOS)
	px = small.load()
	for j in range(size):
		for i in range(size):
			_, _, _, a = px[i, j]
			px[i, j] = (*rgb, a)
	return small


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
			img = recolor(render_tray(hollow), glyph_rgb)
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
		ensure_rasters()
		write_assets()
	write_qa_sheet()


if __name__ == "__main__":
	sys.exit(main())
