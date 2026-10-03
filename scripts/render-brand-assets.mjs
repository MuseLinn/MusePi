// Rasterise the brand marks for scripts/regen-*.py.
//
// The SVGs in packages/desktop-app/build/ are the single geometry source; this
// script only turns them into rasters at the exact pixel sizes the Python
// side needs. The SVG markup is INLINED into the page rather than referenced
// with <img src="file://…">: a page created from about:blank has an opaque
// origin and the browser blocks the file:// sub-resource (the image renders
// broken). CSS then scales the vector, so Chrome rasterises it AT the target
// size instead of downscaling a big render.
//
// Usage: node scripts/render-brand-assets.mjs --out <dir>
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BUILD = join(REPO, "packages", "desktop-app", "build");

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(REPO, ".workbuddy", "brand-qa", "brand-png");

/** size -> which master carries that size. Each size gets its own art. */
const FAVICON_TIERS = [
	[16, "icon-mini-plain.svg"],
	[24, "icon-mini-plain.svg"],
	[32, "icon-mini-plain.svg"],
	[48, "icon-mini.svg"],
	[64, "icon-mini.svg"],
	[96, "icon-mini.svg"],
	[128, "icon.svg"],
	[180, "icon.svg"],
	[192, "icon.svg"],
	[256, "icon.svg"],
	[512, "icon.svg"],
	[1024, "icon.svg"],
];
/** Android adaptive foreground layer: 108dp x density. */
const ANDROID_FG = [108, 162, 216, 324, 432];
/** Android themed-icon (monochrome) layer: same grid, shape only. */
const ANDROID_MONO = [108, 162, 216, 324, 432];
/** Tray glyph: tray.cjs works from a 36px bitmap and resizes to 20 on Windows. */
const TRAY = [36, 72];
/** Splash / large centring source for the Android splash. */
const SPLASH = [512];
/** Status-bar notification glyph, white on transparent (preview + QA). */
const STAT = [24, 96];

const jobs = [
	...FAVICON_TIERS.map(([s, f]) => ({ file: f, size: s, out: `icon-${s}.png` })),
	...ANDROID_FG.map((s) => ({ file: "icon-android-fg.svg", size: s, out: `android-fg-${s}.png` })),
	...ANDROID_MONO.map((s) => ({ file: "icon-android-mono.svg", size: s, out: `android-mono-${s}.png` })),
	...TRAY.flatMap((s) => [
		{ file: "icon-tray-solid.svg", size: s, out: `tray-solid-${s}.png` },
		{ file: "icon-tray-hollow.svg", size: s, out: `tray-hollow-${s}.png` },
	]),
	...SPLASH.map((s) => ({ file: "icon-android-fg.svg", size: s, out: `splash-orb-${s}.png` })),
	...STAT.map((s) => ({ file: "icon-stat.svg", size: s, out: `stat-${s}.png` })),
];

mkdirSync(OUT, { recursive: true });
const cache = new Map();
const readMaster = (file) => {
	if (!cache.has(file)) {
		cache.set(
			file,
			readFileSync(join(BUILD, file), "utf8").replace(
				/<svg([^>]*?)\swidth="\d+"\sheight="\d+"/,
				"<svg$1",
			),
		);
	}
	return cache.get(file);
};

const browser = await chromium.launch();
for (const job of jobs) {
	const src = readMaster(job.file);
	const page = await browser.newPage({
		viewport: { width: job.size, height: job.size },
		deviceScaleFactor: 1,
	});
	await page.setContent(
		`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}` +
			`svg{display:block;width:${job.size}px;height:${job.size}px}</style>${src}`,
	);
	await page.waitForTimeout(90);
	await page.screenshot({ path: join(OUT, job.out), omitBackground: true });
	await page.close();
}
await browser.close();
console.log(`rendered ${jobs.length} rasters -> ${OUT}`);
