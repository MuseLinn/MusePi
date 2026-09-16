# Compose the MusePi brand petdex spritesheet from AI-generated mood frames.
# One-off asset tool: reads generated-images/, writes public/pets/musepi.webp
# Layout: petdex 8×9 grid, mood rows per PETDEX_MOOD_ROW (rest=0, hover=1,
# dragging=2, error=5, waiting=6, working=7, analyzing=8). Base frames are
# reused mid-row so each row loops as a ping-pong (base → v1 → base → v2).
from PIL import Image
from collections import deque
import os

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SRC, "..", "packages", "desktop-app", "public", "pets", "musepi.webp")

HERO = "Sticker_style_chibi_mascot_for_2026-09-15T20-05-08.png"
V = "Keep_this_exact_mascot_charact_2026-09-15T"

MOODS = {
	"rest": {"row": 0, "base": HERO, "frames": ["base", V + "20-11-29.png", "base", V + "20-11-54.png", "base", V + "20-12-16.png"]},
	"hover": {"row": 1, "base": V + "20-07-56.png", "frames": ["base", V + "20-12-38.png", "base", V + "20-13-03.png"]},
	"dragging": {"row": 2, "base": V + "20-08-19.png", "frames": ["base", V + "20-13-34.png", "base", V + "20-14-00.png"]},
	"error": {"row": 5, "base": V + "20-07-31.png", "frames": ["base", V + "20-14-33.png", "base", V + "20-14-56.png"]},
	"waiting": {"row": 6, "base": V + "20-06-43.png", "frames": ["base", V + "20-15-23.png", "base", V + "20-15-49.png"]},
	"working": {"row": 7, "base": V + "20-06-14.png", "frames": ["base", V + "20-16-18.png", "base", V + "20-16-46.png"]},
	"analyzing": {"row": 8, "base": V + "20-07-06.png", "frames": ["base", V + "20-17-12.png", "base", V + "20-17-37.png"]},
}

CELL = 256
COLS = 8
ROWS = 9
TARGET_H = 196  # character height inside a 256px cell (motion lines/wind need side room)
BOTTOM_PAD = 14


def is_bglike(px):
	r, g, b, a = px
	if a == 0:
		return True
	# The generator paints a light checkerboard instead of true alpha.
	# Background-like = bright, near-achromatic pixels (the character's
	# cream body is warm (r−b ≈ 25) and its outline is dark, so neither
	# leaks).
	return min(r, g, b) >= 195 and (max(r, g, b) - min(r, g, b)) <= 20


def strip_background(img: Image.Image) -> Image.Image:
	"""Flood-fill from all four borders, clearing connected background-like
	pixels. The character's thick dark outline stops the fill, so interior
	whites (eye highlights) are untouched."""
	w, h = img.size
	px = img.load()
	seen = bytearray(w * h)
	q = deque()
	for x in range(w):
		for y in (0, h - 1):
			if is_bglike(px[x, y]) and not seen[y * w + x]:
				seen[y * w + x] = 1
				q.append((x, y))
	for y in range(h):
		for x in (0, w - 1):
			if is_bglike(px[x, y]) and not seen[y * w + x]:
				seen[y * w + x] = 1
				q.append((x, y))
	while q:
		x, y = q.popleft()
		px[x, y] = (0, 0, 0, 0)
		for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
			if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_bglike(px[nx, ny]):
				seen[ny * w + nx] = 1
				q.append((nx, ny))
	return img


def load(name: str) -> Image.Image:
	img = Image.open(os.path.join(SRC, name)).convert("RGBA")
	# Kill the generator watermark (bottom-right, on the transparent margin).
	px = img.load()
	w, h = img.size
	for y in range(940, h):
		for x in range(600, w):
			r, g, b, a = px[x, y]
			if a:
				px[x, y] = (r, g, b, 0)
	img = strip_background(img)
	return img


def alpha_bbox(img: Image.Image):
	return img.split()[3].getbbox()


sheet = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
rows_valid = [0] * ROWS
content_top = CELL
content_bottom = 0

for mood, spec in MOODS.items():
	base = load(spec["base"])
	bb = alpha_bbox(base)
	k = TARGET_H / (bb[3] - bb[1])
	row = spec["row"]
	rows_valid[row] = len(spec["frames"])
	for col, name in enumerate(spec["frames"]):
		frame = base if name == "base" else load(name)
		fb = alpha_bbox(frame)
		fw = round((fb[2] - fb[0]) * k)
		fh = round((fb[3] - fb[1]) * k)
		resized = frame.crop(fb).resize((fw, fh), Image.LANCZOS)
		# Bottom-center anchor: feet stay planted across frames.
		x = col * CELL + (CELL - fw) // 2
		y = (row + 1) * CELL - BOTTOM_PAD - fh
		sheet.alpha_composite(resized, (x, y))
		if row == 0:
			content_top = min(content_top, y - row * CELL)
			content_bottom = max(content_bottom, y - row * CELL + fh)

content_h = content_bottom - content_top + 1
sheet.save(OUT, "WEBP", quality=90, method=6)
kb = os.path.getsize(OUT) // 1024
print(f"sheet: {OUT}")
print(f"rows: {rows_valid}")
print(f"contentH: {content_h}")
print(f"size: {kb} KB")
