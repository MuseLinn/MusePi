import { type ReactElement, useEffect, useRef } from "react";

/** MusePi accent palette for the ~2% colored dots (kept small; the flowing
 *  hue shift keeps them lively without reading as noise). */
const ACCENT_COLORS = ["#ff6b6b", "#51cf66", "#339af0", "#cc5de8", "#ffd43b"];

/**
 * Interactive dot-matrix brand mark (kimi-style reference + MusePi polish):
 * the text is rasterized to a full rectangular dot grid — light background
 * dots, dark text dots, ~2% colored accents that slowly flow hue, a feather
 * edge that fades dots past the text bounds, gentle breathing, a mouse halo
 * that magnifies + darkens nearby text dots, and a click ripple that pushes
 * a wave outward through the dots. Canvas-based; pauses when offscreen.
 *
 * i18n-aware glyph rasterization: CJK/JP/KR text picks matching font stacks
 * and auto-shrinks the sample size so long labels stay inside the canvas.
 */
export function DotMatrixMark({
	text,
	className = "",
	gridGap = 7,
	dotRadius = 2.0,
	mouseRadius = 110,
	accentChance = 0.02,
	accentColors = ACCENT_COLORS,
	fontSize,
}: {
	text: string;
	className?: string;
	gridGap?: number;
	dotRadius?: number;
	mouseRadius?: number;
	accentChance?: number;
	accentColors?: string[];
	/** Raster font size override — the settings preview renders a smaller
	 *  field than the welcome backdrop so it passes a bounded size. */
	fontSize?: number;
}): ReactElement {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let W = 0;
		let H = 0;
		let raf = 0;
		let disposed = false;
		const mouse = { x: -9999, y: -9999, active: true };
		let time = 0;

		// Theme-aware colors; re-read when <html> data-theme flips.
		let textColor = "#333333";
		let bgColor = "#e0e0e0";
		let activeColor = "#111111";
		const readTheme = (): void => {
			const cs = getComputedStyle(document.documentElement);
			const fg = cs.getPropertyValue("--color-text").trim() || "#333333";
			textColor = fg;
			// Background dots need real presence or the grid reads as
			// nothing: 0.20 on light themes, 0.30 on dark (dark backdrops
			// swallow low-alpha gray dots harder).
			const isDark = document.documentElement.dataset.theme === "dark";
			bgColor = colorMix(fg, isDark ? 0.3 : 0.2);
			activeColor = cs.getPropertyValue("--color-accent").trim() || "#111111";
		};
		readTheme();
		const themeObserver = new MutationObserver(readTheme);
		themeObserver.observe(document.documentElement, { attributes: true });

		// ── i18n-aware rasterization font ──────────────────────────────
		const detectScript = (label: string): { cjk: boolean; jp: boolean; kr: boolean } => ({
			cjk: /[\u4e00-\u9fff]/.test(label),
			jp: /[\u3040-\u309f\u30a0-\u30ff]/.test(label),
			kr: /[\uac00-\ud7af]/.test(label),
		});
		const getFontConfig = (label: string): { fontSize: number; fontStack: string } => {
			const { cjk, jp, kr } = detectScript(label);
			// 140px 600-weight system sans: 600 (vs bold/700) thins the M's
			// diagonal strokes — at 700 they rasterize as solid 2-3 column
			// blocks and the M reads as a lumpy square; 600 leaves the
			// pixel stair-step that reads as a proper M in dot matrix.
			let size = fontSize ?? 140;
			let fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
			if (jp) {
				fontStack = "'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif";
			} else if (kr) {
				fontStack = "'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";
			} else if (cjk) {
				fontStack =
					"'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', 'Source Han Sans SC', sans-serif";
			}
			// Long labels shrink the sample so the mask stays inside the
			// 1400×400 raster canvas (and the dot field stays bounded).
			const len = label.length;
			if (cjk && len > 8) size = Math.min(size, 90);
			else if (cjk && len > 4) size = Math.min(size, 120);
			else if (len > 10) size = Math.min(size, 85);
			else if (len > 6) size = Math.min(size, 115);
			return { fontSize: size, fontStack };
		};

		// ── Deterministic randomness: accent dots and the entrance scatter
		// come from a text-seeded PRNG re-seeded inside build(), so every
		// rebuild (window resize, sidebar collapse re-layout, re-entry)
		// re-renders the exact same pattern — the accent dots never re-roll
		// or shift while the user adjusts the layout. ───────────────────
		const hashStr = (s: string): number => {
			let h = 0x811c9dc5;
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 0x01000193);
			}
			return h >>> 0;
		};
		const mulberry32 = (seed: number): (() => number) => {
			let a = seed | 0;
			return () => {
				a = (a + 0x6d2b79f5) | 0;
				let t = Math.imul(a ^ (a >>> 15), 1 | a);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		};

		// Offscreen text mask (cached per label + raster size). The
		// settings preview (fontSize=96) and the welcome backdrop (140)
		// render the same label at different sizes — sharing one mask
		// would rasterize the wrong shape, and a fontSize change must
		// rebuild, not reuse a stale cache entry.
		const maskCache = new Map<
			string,
			{ mask: Set<string>; minX: number; minY: number; maxX: number; maxY: number }
		>();
		const getTextMask = (
			label: string,
		): { mask: Set<string>; minX: number; minY: number; maxX: number; maxY: number } => {
			const { fontSize, fontStack } = getFontConfig(label);
			const cacheKey = `${label}\u0000${fontSize}`;
			const cached = maskCache.get(cacheKey);
			if (cached) return cached;
			const off = document.createElement("canvas");
			off.width = 1400;
			off.height = 400;
			const octx = off.getContext("2d")!;
			octx.fillStyle = "#000";
			octx.font = `600 ${fontSize}px ${fontStack}`;
			octx.textAlign = "center";
			octx.textBaseline = "middle";
			octx.fillText(label, off.width / 2, off.height / 2);
			const data = octx.getImageData(0, 0, off.width, off.height).data;
			const mask = new Set<string>();
			let minX = Infinity;
			let maxX = -Infinity;
			let minY = Infinity;
			let maxY = -Infinity;
			const half = gridGap / 2;
			for (let y = 0; y < off.height; y += gridGap) {
				for (let x = 0; x < off.width; x += gridGap) {
					// Subsample the four cell corners; any coverage counts.
					let hit = false;
					for (const [sx, sy] of [
						[0, 0],
						[half, 0],
						[0, half],
						[half, half],
					] as const) {
						const px = Math.min(off.width - 1, Math.floor(x + sx));
						const py = Math.min(off.height - 1, Math.floor(y + sy));
						const idx = (py * off.width + px) * 4;
						if (data[idx + 3]! > 60) {
							hit = true;
							break;
						}
					}
					if (!hit) continue;
					mask.add(`${x},${y}`);
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
			const entry = { mask, minX, minY, maxX, maxY };
			maskCache.set(cacheKey, entry);
			return entry;
		};

		/** 0 → 1 near the text bounds, fading over `margin` px outside. */
		const featherMargin = 42;
		let featherBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
		const featherFactor = (x: number, y: number): number => {
			const dx = Math.max(featherBounds.minX - x, 0, x - featherBounds.maxX);
			const dy = Math.max(featherBounds.minY - y, 0, y - featherBounds.maxY);
			const dist = Math.hypot(dx, dy);
			const t = Math.min(1, dist / featherMargin);
			// 1 - smoothstep: stays 1 inside the bounds, eases to 0.
			return 1 - t * t * (3 - 2 * t);
		};

		// ── Accent hue flow: pre-parsed HSL per accent dot, re-derived
		// per frame from a slow sine — cheap, no string churn. ──────────
		const hexToHsl = (hex: string): { h: number; s: number; l: number } | null => {
			const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
			if (!m) return null;
			const n = Number.parseInt(m[1]!, 16);
			const r = ((n >> 16) & 0xff) / 255;
			const g = ((n >> 8) & 0xff) / 255;
			const b = (n & 0xff) / 255;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const l = (max + min) / 2;
			if (max === min) return { h: 0, s: 0, l };
			const d = max - min;
			const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
			let h: number;
			if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
			else if (max === g) h = (b - r) / d + 2;
			else h = (r - g) / d + 4;
			return { h: (h / 6) % 1, s, l };
		};
		const hslToRgb = (h: number, s: number, l: number): string => {
			const hue2rgb = (p: number, q: number, t: number): number => {
				if (t < 0) t += 1;
				if (t > 1) t -= 1;
				if (t < 1 / 6) return p + (q - p) * 6 * t;
				if (t < 1 / 2) return q;
				if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
				return p;
			};
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
			const g = Math.round(hue2rgb(p, q, h) * 255);
			const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
			return `rgb(${r},${g},${b})`;
		};

		// Click ripples: a wavefront expands from the click point; dots in
		// the band get a radial push + magnify, fading as the wave grows.
		type Ripple = { x: number; y: number; start: number };
		const RIPPLE_SPEED = 0.55; // px/ms
		const RIPPLE_WIDTH = 26;
		const RIPPLE_STRENGTH = 1.25;
		const RIPPLE_MAX_WAVE = 900;
		const ripples: Ripple[] = [];

		type Dot = {
			ox: number;
			oy: number;
			x: number;
			y: number;
			vx: number;
			vy: number;
			isText: boolean;
			r: number;
			baseR: number;
			phase: number;
			alpha: number;
			accent: { h: number; s: number; l: number } | null;
			accentPhase: number;
		};
		let dots: Dot[] = [];
		let bgIndices: number[] = [];
		let textIndices: number[] = [];
		let built = false;
		let lastW = 0;
		let lastH = 0;

		const build = (): void => {
			const { mask, minX, minY, maxX, maxY } = getTextMask(text);
			const textW = maxX - minX;
			const textH = maxY - minY;
			// Integer offsets: a fractional offX shifts the mask lookup by
			// up to half a cell and letter edges (like M) render lopsided.
			const offX = Math.round((W - textW) / 2 - minX);
			const offY = Math.round((H - textH) / 2 - minY);
			const pad = 36;
			const startX = Math.floor(((W - textW) / 2 - pad) / gridGap) * gridGap;
			const endX = Math.ceil(((W + textW) / 2 + pad) / gridGap) * gridGap;
			const startY = Math.floor(((H - textH) / 2 - pad) / gridGap) * gridGap;
			const endY = Math.ceil(((H + textH) / 2 + pad) / gridGap) * gridGap;
			// Feather fades over the padded band past the text bounds —
			// bounds in PAGE coordinates (the mask bbox lives in offscreen
			// raster space and must be offset, or every dot lands outside
			// and alpha fades to zero).
			featherBounds = {
				minX: (W - textW) / 2,
				maxX: (W + textW) / 2,
				minY: (H - textH) / 2,
				maxY: (H + textH) / 2,
			};
			const next: Dot[] = [];
			// Fresh seed per build so rebuilds (resize/layout) reproduce the
			// exact same field instead of re-rolling the accent dots.
			const rng = mulberry32(hashStr(text));
			for (let y = startY; y <= endY; y += gridGap) {
				for (let x = startX; x <= endX; x += gridGap) {
					if (x < 0 || x > W || y < 0 || y > H) continue;
					const mx = Math.round((x - offX) / gridGap) * gridGap;
					const my = Math.round((y - offY) / gridGap) * gridGap;
					const isText = mask.has(`${mx},${my}`);
					const accentHex =
						isText && rng() < accentChance ? accentColors[Math.floor(rng() * accentColors.length)]! : null;
					// First build scatters the dots (entrance); rebuilds
					// (resize) settle them in place so the mark never
					// re-plays its entrance animation.
					const scatter = !built ? (rng() - 0.5) * 18 : 0;
					next.push({
						ox: x,
						oy: y,
						x: x + scatter,
						y: y + scatter,
						vx: 0,
						vy: 0,
						isText,
						r: 0,
						baseR: isText ? dotRadius : dotRadius * 0.6,
						phase: rng() * Math.PI * 2,
						alpha: featherFactor(x, y),
						accent: accentHex ? hexToHsl(accentHex) : null,
						accentPhase: rng() * Math.PI * 2,
					});
				}
			}
			dots = next;
			// Layer indices once per build; frame() walks these instead of
			// allocating two arrays (plus a spread) every rAF tick.
			bgIndices = [];
			textIndices = [];
			for (let i = 0; i < next.length; i++) (next[i]!.isText ? textIndices : bgIndices).push(i);
			built = true;
		};

		const resize = (): void => {
			const rect = canvas.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			W = rect.width;
			H = rect.height;
			// Size unchanged (e.g. re-entering the scene or focus morphs
			// touching layout): never rebuild — that replays the entrance.
			if (W === lastW && H === lastH) return;
			lastW = W;
			lastH = H;
			canvas.width = Math.max(1, Math.round(W * dpr));
			canvas.height = Math.max(1, Math.round(H * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			build();
		};

		const frame = (): void => {
			if (disposed) return;
			time += 0.016;
			ctx.clearRect(0, 0, W, H);
			// Background dots first, text dots on top (pre-built indices —
			// no per-frame array allocation).
			for (const i of bgIndices) drawDot(dots[i]!);
			for (const i of textIndices) drawDot(dots[i]!);
			// Expire finished ripples.
			if (ripples.length > 0) {
				const now = performance.now();
				for (let i = ripples.length - 1; i >= 0; i--) {
					if (RIPPLE_SPEED * (now - ripples[i]!.start) > RIPPLE_MAX_WAVE) ripples.splice(i, 1);
				}
			}
			raf = requestAnimationFrame(frame);
		};

		const drawDot = (d: Dot): void => {
			// Breathing.
			const bx = Math.sin(time * 0.4 + d.phase) * 0.6;
			const by = Math.cos(time * 0.28 + d.phase) * 0.6;
			const tx = d.ox + bx;
			const ty = d.oy + by;
			// Mouse halo: repel + magnify.
			let mouseScale = 1;
			if (mouse.active) {
				const dx = mouse.x - d.x;
				const dy = mouse.y - d.y;
				const dist = Math.hypot(dx, dy);
				if (dist < mouseRadius) {
					const t = 1 - dist / mouseRadius;
					d.vx += dx * t * 0.005;
					d.vy += dy * t * 0.005;
					mouseScale = 1 + t * (d.isText ? 1.0 : 0.3);
				}
			}
			// Click ripples: a radial impulse when the wavefront
			// crosses the dot, fading with distance travelled.
			if (ripples.length > 0) {
				for (const rp of ripples) {
					const wave = RIPPLE_SPEED * (performance.now() - rp.start);
					if (wave > RIPPLE_MAX_WAVE) continue;
					const dx = d.x - rp.x;
					const dy = d.y - rp.y;
					const dist = Math.hypot(dx, dy);
					const band = Math.abs(dist - wave);
					if (band < RIPPLE_WIDTH) {
						const t = 1 - band / RIPPLE_WIDTH;
						const falloff = Math.max(0, 1 - wave / RIPPLE_MAX_WAVE);
						const pulse = t * RIPPLE_STRENGTH * falloff;
						const nx = dist > 0.01 ? dx / dist : 0;
						const ny = dist > 0.01 ? dy / dist : 0;
						d.vx += nx * pulse * 5;
						d.vy += ny * pulse * 5;
						if (1 + pulse * 1.5 > mouseScale) mouseScale = 1 + pulse * 1.5;
					}
				}
			}
			d.vx += (tx - d.x) * 0.08;
			d.vy += (ty - d.y) * 0.08;
			d.vx *= 0.88;
			d.vy *= 0.88;
			d.x += d.vx;
			d.y += d.vy;
			d.r += (d.baseR * mouseScale - d.r) * 0.04;
			// Feather follows the dot: pushed toward the edge by a halo or
			// ripple, the dot fades out instead of staying at its build-time
			// alpha (cheap — a few Math.max per dot).
			d.alpha = featherFactor(d.x, d.y);

			const inMouse = mouse.active && Math.hypot(mouse.x - d.x, mouse.y - d.y) < mouseRadius * 0.4;
			let color: string;
			if (inMouse) {
				color = activeColor;
			} else if (d.accent) {
				// Slow hue flow over the accent palette.
				const shift = Math.sin(time * 0.35 + d.accentPhase) * 0.12;
				color = hslToRgb((d.accent.h + shift + 1) % 1, d.accent.s, d.accent.l);
			} else {
				color = d.isText ? textColor : bgColor;
			}
			ctx.globalAlpha = d.alpha;
			ctx.beginPath();
			ctx.arc(d.x, d.y, Math.max(0.2, d.r), 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
			if (inMouse && d.isText) {
				ctx.beginPath();
				ctx.arc(d.x, d.y, d.r * 3, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(0,0,0,0.04)";
				ctx.fill();
			}
		};

		// Pause when offscreen (welcome scene hidden under a session).
		const io = new IntersectionObserver(entries => {
			const visible = entries[0]?.isIntersecting ?? true;
			if (visible && !disposed && raf === 0) raf = requestAnimationFrame(frame);
			if (!visible && raf !== 0) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
		});
		io.observe(canvas);

		// Re-rasterize whenever the canvas element's layout size changes —
		// window resize AND in-page re-layouts like collapsing the session
		// sidebar, which never fire a window resize event. Without this the
		// bitmap keeps its old dimensions, gets stretched by CSS, and the
		// mouse halo coordinates drift from the drawn dots. The rebuild is
		// seeded, so the pattern itself never changes.
		const ro = new ResizeObserver(() => {
			resize();
		});
		ro.observe(canvas);

		const onMove = (e: MouseEvent): void => {
			const rect = canvas.getBoundingClientRect();
			mouse.x = e.clientX - rect.left;
			mouse.y = e.clientY - rect.top;
			mouse.active = true;
		};
		const onLeave = (): void => {
			mouse.x = -9999;
			mouse.y = -9999;
			mouse.active = false;
		};
		const onDown = (e: PointerEvent): void => {
			const rect = canvas.getBoundingClientRect();
			ripples.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, start: performance.now() });
			if (ripples.length > 4) ripples.shift();
		};
		window.addEventListener("resize", resize);
		canvas.addEventListener("mousemove", onMove);
		canvas.addEventListener("mouseleave", onLeave);
		canvas.addEventListener("pointerdown", onDown);
		resize();
		raf = requestAnimationFrame(frame);

		return () => {
			disposed = true;
			cancelAnimationFrame(raf);
			io.disconnect();
			ro.disconnect();
			themeObserver.disconnect();
			window.removeEventListener("resize", resize);
			canvas.removeEventListener("mousemove", onMove);
			canvas.removeEventListener("mouseleave", onLeave);
			canvas.removeEventListener("pointerdown", onDown);
		};
		// Only primitives: text/gridGap/dotRadius/mouseRadius/accentChance
		// (accentColors is the module-level ACCENT_COLORS — stable identity,
		// deliberately not in the deps).
	}, [text, gridGap, dotRadius, mouseRadius, accentChance, fontSize, accentColors.length, accentColors]);

	return <canvas ref={canvasRef} className={`gui-dot-matrix ${className}`} aria-hidden="true" />;
}

/** Muted rgba() derived from a #rrggbb color (background dots). */
function colorMix(color: string, alpha: number): string {
	const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
	if (!m) return `rgba(128,128,128,${alpha})`;
	const n = Number.parseInt(m[1]!, 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	return `rgba(${r},${g},${b},${alpha})`;
}
