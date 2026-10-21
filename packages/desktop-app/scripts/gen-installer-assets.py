#!/usr/bin/env python3
"""Generate NSIS branding bitmaps from the MusePi brand icon.

NSIS's Modern UI bitmaps must be **24-bit BMP without an alpha channel** —
PNG with transparency silently fails to load (the wizard falls back to the
stock Metro art with no error). So the icon's transparent margin is flattened
onto the brand dark canvas and written as BGR.

Outputs (into packages/desktop-app/build/):
  installerSidebar.bmp   164x314  welcome/finish page left column
  installerHeader.bmp    150x57   header strip on directory/instfiles pages
  uninstallerSidebar.bmp 164x314  uninstall wizard left column

Run: python packages/desktop-app/scripts/gen-installer-assets.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover - tooling guard
    sys.exit("Pillow is required: pip install Pillow")

APP_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = APP_DIR / "build"
ICON_PNG = BUILD_DIR / "icon.png"

# Brand dark canvas — matches the app icon's card gradient (#242128 → #1b191f).
BG_TOP = (36, 33, 40)
BG_BOTTOM = (27, 25, 31)

SIDEBAR = (164, 314)
HEADER = (150, 57)


def load_icon_on_canvas(size: int) -> Image.Image:
    """Return the brand icon composited onto the dark canvas at `size` px."""
    if not ICON_PNG.exists():
        sys.exit(f"brand icon not found: {ICON_PNG}")
    icon = Image.open(ICON_PNG).convert("RGBA")
    icon = icon.resize((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BG_TOP + (255,))
    canvas.alpha_composite(icon)
    return canvas


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    gradient = Image.new("RGB", (1, height))
    pixels = gradient.load()
    for y in range(height):
        t = y / max(1, height - 1)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return gradient.resize((width, height), Image.BILINEAR)


def render_sidebar() -> Image.Image:
    """164x314: gradient field, brand mark centred, soft bottom glow."""
    width, height = SIDEBAR
    canvas = vertical_gradient(SIDEBAR, BG_TOP, BG_BOTTOM).convert("RGBA")

    mark = load_icon_on_canvas(112)
    # Rounded corners keep the icon from reading as a hard square on the gradient.
    mask = Image.new("L", (112, 112), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 111, 111), radius=24, fill=255)
    canvas.paste(mark, ((width - 112) // 2, (height - 112) // 2 - 18), mask)

    # Warm lamp glow behind the mark — the icon's own accent, at low opacity.
    glow = Image.new("RGBA", SIDEBAR, (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        ((width - 168) // 2, (height - 168) // 2 - 18, (width + 168) // 2, (height + 168) // 2 - 18),
        fill=(255, 205, 130, 26),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(18))
    canvas = Image.alpha_composite(canvas, glow)

    # Re-paste the mark above the glow so it stays crisp.
    canvas.paste(mark, ((width - 112) // 2, (height - 112) // 2 - 18), mask)

    # 1px hairline on the right edge separates the sidebar from the page body.
    ImageDraw.Draw(canvas).line((width - 1, 0, width - 1, height), fill=(255, 255, 255, 18))
    return canvas


def render_header() -> Image.Image:
    """150x57: gradient field with the brand mark at the right, vertically centred."""
    width, height = HEADER
    canvas = vertical_gradient(HEADER, BG_TOP, BG_BOTTOM).convert("RGBA")

    mark = load_icon_on_canvas(40)
    mask = Image.new("L", (40, 40), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 39, 39), radius=9, fill=255)
    canvas.paste(mark, (width - 40 - 12, (height - 40) // 2), mask)
    return canvas


def save_bmp(image: Image.Image, path: Path) -> None:
    """Write 24-bit BMP — NSIS MUI rejects 32-bit and alpha."""
    image.convert("RGB").save(path, format="BMP")
    print(f"  wrote {path.name}  {image.size[0]}x{image.size[1]}  24-bit")


def main() -> int:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    print("[installer-assets] generating NSIS branding bitmaps")
    sidebar = render_sidebar()
    save_bmp(sidebar, BUILD_DIR / "installerSidebar.bmp")
    save_bmp(sidebar, BUILD_DIR / "uninstallerSidebar.bmp")
    save_bmp(render_header(), BUILD_DIR / "installerHeader.bmp")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
