#!/usr/bin/env bun
/**
 * End-to-end check for the marketing preview's self-loading behaviour and its
 * runtime cost.
 *
 * The site embeds the real desktop renderer from `web/app/` against the in-page
 * fixture daemon in `web/demo-src/`, pinned to ws://127.0.0.1:9/demo. This
 * script serves the whole site (the page's own scripts and styles drive the
 * mount), scrolls the preview into view in headless Edge, and asserts what a
 * visitor depends on:
 *
 *   1. nothing loads at the top of the page — no iframe, no `/app/` request
 *   2. scrolling `#preview` into view mounts the frame and reaches `ready`
 *      with no click
 *   3. the four demo tabs drive the real renderer (composer, transcript,
 *      file tree, board surface)
 *   4. no request reaches a daemon on :8300, and the only failed request is
 *      the browser's own `/favicon.ico` probe
 *   5. the fallback panel never becomes visible
 *   6. the artifact is fetched once per file, with the shell's chunks issued
 *      together instead of as a waterfall
 *   7. the 1440x900 layout stays inside its stage and keeps its scale at
 *      1440, 1024, 848 and in fullscreen
 *   8. repeated scrolling and tab clicks mount exactly one frame and produce
 *      one transition per state; the loading overlay never returns after ready
 *   9. a reduced-motion visitor gets the preview with no animation
 *  10. a missing artifact and a chunk that fails mid-load both reach the
 *      fallback, whose retry is bounded and whose actions point at the app
 *
 * Serving from a free loopback port keeps a run independent of the dev server
 * on :5197 and of any daemon a developer has running.
 *
 * Usage (repo root):
 *   bun packages/desktop-app/scripts/verify-site-preview.mjs
 *   bun packages/desktop-app/scripts/verify-site-preview.mjs --port 5299
 *   bun packages/desktop-app/scripts/verify-site-preview.mjs --edge "C:/Edge/msedge.exe"
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const repoRoot = path.resolve(import.meta.dir, "../../..");
const webRoot = path.join(repoRoot, "web");
const shotsDir = path.join(repoRoot, ".tmp", "site-preview-verify");
const EDGE = flag("--edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
const PORT = Number(flag("--port", "0"));
const VIEWPORT = { width: 1440, height: 900 };
const MOUNT_TIMEOUT_MS = 30_000;
// The artifact is ~22 MiB of JS on a cold cache; the site itself budgets 90 s
// for the boot, so the check must not be stricter than the product.
const READY_TIMEOUT_MS = 120_000;
const TAB_TIMEOUT_MS = 25_000;
// The page fails a boot whose shell never paints 15 s after its own load; the
// check allows for the mount, that budget and a slow runner.
const STALL_TIMEOUT_MS = 45_000;
const FAILURE_TIMEOUT_MS = 20_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const startedAt = Date.now();

function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  · ${detail}` : ""}`);
}

function pathOf(url) {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}

if (!existsSync(EDGE)) {
	console.error(`[site-preview] Edge not found at ${EDGE} — pass --edge <path>`);
	process.exit(2);
}
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65_535) {
	console.error(`[site-preview] invalid --port ${flag("--port", "")}`);
	process.exit(2);
}
mkdirSync(shotsDir, { recursive: true });

let server;
let browser;

async function cleanup() {
	const closing = browser;
	browser = null;
	if (closing) await closing.close().catch(() => {});
	if (server) {
		server.stop(true);
		server = null;
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		cleanup().finally(() => process.exit(130));
	});
}

function serveSite() {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: PORT,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			let decoded;
			try {
				decoded = decodeURIComponent(pathname);
			} catch {
				return new Response("bad path", { status: 400 });
			}
			const relative = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
			const filePath = path.join(webRoot, relative);
			if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
				return new Response("forbidden", { status: 403 });
			}
			const file = Bun.file(filePath);
			if (!(await file.exists())) return new Response("not found", { status: 404 });
			return new Response(file, { headers: { "cache-control": "no-store" } });
		},
	});
}

/**
 * Read both pages: the marketing document and the renderer inside the frame.
 * Only visible nodes count — the app keeps mounted scenes and hidden panes in
 * the tree, so presence alone would pass on a view that is not on screen.
 */
function demoSnapshot(page) {
	return page.evaluate(() => {
		const embed = document.querySelector("[data-demo-embed]");
		const stage = document.querySelector("[data-demo-stage]");
		const frame = stage?.querySelector("iframe") ?? null;
		const doc = frame?.contentDocument ?? null;
		const visibleIn = document => element => {
			if (!element || element.hidden) return false;
			const style = document.defaultView.getComputedStyle(element);
			return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
		};
		const visible = visibleIn(doc ?? document);
		const count = selector => (doc ? [...doc.querySelectorAll(selector)].filter(visible).length : 0);
		const fallback = document.querySelector("[data-demo-fallback]");
		const fallbackVisible = fallback ? visibleIn(document)(fallback) : false;
		return {
			state: embed?.dataset.state ?? null,
			iframe: Boolean(frame),
			stageIframes: stage ? stage.querySelectorAll("iframe").length : 0,
			welcome: count(".gui-welcome"),
			welcomeInput: count(".gui-welcome-input"),
			composer: count(".gui-composer"),
			textareas: count("textarea"),
			transcript: count(".gui-transcript"),
			entries: count(".tr-entry"),
			filePane: count(".gui-filepane"),
			fileNames: doc ? [...doc.querySelectorAll(".gui-filepane-name")].map(node => node.textContent.trim()) : [],
			treeRows: doc ? doc.querySelectorAll(".gui-filepane-vrow").length : 0,
			visibleTreeRows: count(".gui-filepane-vrow"),
			visibleFileNames: doc
				? [...doc.querySelectorAll(".gui-filepane-vrow")]
						.filter(visible)
						.map(row => row.querySelector(".gui-filepane-name")?.textContent.trim() ?? "")
				: [],
			treeToggle: count(".gui-filepane-tree-toggle"),
			treeOpen: Boolean(doc?.querySelector(".gui-filepane-preview-main--tree-open")),
			treeWidth: doc?.querySelector(".gui-filepane-list")?.getBoundingClientRect().width ?? 0,
			board: count(".gui-board"),
			boardHome: count(".gui-board-home"),
			fallbackVisible,
			fallbackSeen: document.documentElement.dataset.demoFallbackSeen === "1",
			loadingAfterReady: document.documentElement.dataset.demoLoadingAfterReady === "1",
			mounts: window.__demo?.mounts ?? -1,
			states: window.__demo?.states ?? [],
		};
	});
}

/** Where the scaled renderer sits inside its stage, and at what scale. */
function demoGeometry(page) {
	return page.evaluate(() => {
		const screen = document.querySelector("[data-demo-screen]");
		const frame = document.querySelector("[data-demo-stage] iframe");
		if (!screen || !frame) return null;
		const s = screen.getBoundingClientRect();
		const f = frame.getBoundingClientRect();
		const scale = /scale\(([\d.]+)\)/.exec(frame.style.transform ?? "");
		return {
			screen: { width: s.width, height: s.height },
			frame: {
				width: f.width,
				height: f.height,
				left: f.left - s.left,
				top: f.top - s.top,
				right: f.right - s.left,
				bottom: f.bottom - s.top,
			},
			scale: scale ? Number(scale[1]) : 0,
			expected: Math.min(s.width / 1440, s.height / 900),
			fullscreen: Boolean(document.fullscreenElement),
		};
	});
}

/** The frame must fit the stage, stay centred, and keep the authored scale. */
function scaleIsSound(geometry) {
	if (!geometry) return false;
	const { screen, frame, scale, expected } = geometry;
	const slack = 0.6;
	const centred = Math.abs(frame.left - (screen.width - frame.right)) <= 1.5;
	return (
		Math.abs(scale - expected) <= 0.005 &&
		frame.left >= -slack &&
		frame.top >= -slack &&
		frame.right <= screen.width + slack &&
		frame.bottom <= screen.height + slack &&
		centred
	);
}

function scaleDetail(geometry) {
	if (!geometry) return "no frame";
	const { screen, frame, scale, expected } = geometry;
	return `stage ${Math.round(screen.width)}x${Math.round(screen.height)} · scale ${scale.toFixed(4)} (want ${expected.toFixed(4)}) · frame ${Math.round(frame.width)}x${Math.round(frame.height)}`;
}

async function waitForCondition(predicate, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started <= timeoutMs) {
		if (await predicate()) return true;
		await sleep(100);
	}
	return false;
}

async function waitForScale(page, timeoutMs = 4000) {
	const started = Date.now();
	let geometry = await demoGeometry(page);
	while (!scaleIsSound(geometry)) {
		if (Date.now() - started > timeoutMs) return { ok: false, geometry };
		await sleep(100);
		geometry = await demoGeometry(page);
	}
	return { ok: true, geometry };
}

async function waitForSnapshot(page, predicate, timeoutMs) {
	const started = Date.now();
	let snapshot = await demoSnapshot(page);
	while (!predicate(snapshot)) {
		if (Date.now() - started > timeoutMs) return { ok: false, elapsed: Date.now() - started, snapshot };
		await sleep(150);
		snapshot = await demoSnapshot(page);
	}
	return { ok: true, elapsed: Date.now() - started, snapshot };
}

async function shot(page, name) {
	const file = path.join(shotsDir, name);
	await page.screenshot({ path: file });
	const kib = (readFileSync(file).length / 1024).toFixed(0);
	console.log(`      shot ${path.relative(repoRoot, file)}  ${kib} KiB`);
}

/**
 * Record what only the page can see: the frame mounts, every `data-state`
 * transition, and the two states a visitor must never be shown at the wrong
 * time (the fallback panel, the loading overlay after ready).
 *
 * Installed after the page's own load and before the scroll that mounts the
 * preview: `Page.addScriptToEvaluateOnNewDocument` is a no-op in the Edge
 * build this runs on, so a pre-document probe would silently record nothing.
 */
async function installProbes(page) {
	await page.evaluate(() => {
		const visible = element => {
			if (!element || element.hidden) return false;
			const style = getComputedStyle(element);
			return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
		};
		window.__demo = { mounts: 0, states: [] };
		const probe = () => {
			if (visible(document.querySelector("[data-demo-fallback]"))) {
				document.documentElement.dataset.demoFallbackSeen = "1";
			}
			const state = document.querySelector("[data-demo-embed]")?.dataset.state;
			if (state === "ready" && visible(document.querySelector("[data-demo-loading]"))) {
				document.documentElement.dataset.demoLoadingAfterReady = "1";
			}
		};
		const stage = document.querySelector("[data-demo-stage]");
		const embed = document.querySelector("[data-demo-embed]");
		if (stage) {
			new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (node.nodeType === 1 && node.tagName === "IFRAME") window.__demo.mounts += 1;
					}
				}
			}).observe(stage, { childList: true, subtree: true });
		}
		if (embed) {
			new MutationObserver(() => window.__demo.states.push(embed.dataset.state)).observe(embed, {
				attributes: true,
				attributeFilter: ["data-state"],
			});
		}
		probe();
		new MutationObserver(probe).observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state"],
		});
		setInterval(probe, 150);
	});
}

/** Every request the page made, with start offset and transferred size. */
function watchNetwork(page) {
	const requests = [];
	const failedRequests = [];
	const badResponses = [];
	const pageErrors = [];
	const started = { at: Date.now() };
	page.on("request", request =>
		requests.push({ url: request.url(), path: pathOf(request.url()), at: Date.now() - started.at, bytes: 0 }),
	);
	page.on("requestfailed", request =>
		failedRequests.push({ url: request.url(), detail: request.failure()?.errorText ?? "unknown" }),
	);
	page.on("response", response => {
		if (response.status() >= 400) badResponses.push({ url: response.url(), detail: `HTTP ${response.status()}` });
		const length = Number(response.headers()["content-length"] ?? 0);
		if (!length) return;
		const row = requests.find(entry => entry.url === response.url() && !entry.bytes);
		if (row) row.bytes = length;
	});
	page.on("pageerror", error => pageErrors.push(String(error?.message ?? error)));
	return { requests, failedRequests, badResponses, pageErrors, started };
}

/** Serve the site but replace the artifact (or one chunk) with a 404. */
async function blockArtifact(page, blockedPath) {
	await page.setRequestInterception(true);
	page.on("request", request => {
		if (pathOf(request.url()) === blockedPath) {
			request.respond({ status: 404, contentType: "text/plain", body: "not found" });
			return;
		}
		request.continue();
	});
}

async function scrollToPreview(page) {
	await page.evaluate(() => document.getElementById("preview")?.scrollIntoView({ block: "center" }));
}

async function openPage(viewport = VIEWPORT) {
	const page = await browser.newPage();
	await page.setViewport(viewport);
	return page;
}

try {
	server = serveSite();
	const baseUrl = `http://127.0.0.1:${server.port}/`;
	console.log(`[site-preview] ${baseUrl}  web/  Edge headless ${VIEWPORT.width}x${VIEWPORT.height}`);

	browser = await puppeteer.launch({
		executablePath: EDGE,
		headless: true,
		args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--hide-scrollbars", "--force-color-profile=srgb"],
	});
	const page = await openPage();
	const net = watchNetwork(page);

	await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
	await installProbes(page);
	await sleep(500);

	const top = await demoSnapshot(page);
	const topAppRequests = net.requests.filter(entry => entry.path.startsWith("/app/")).length;
	await shot(page, "01-top.png");
	check(
		"top · no iframe in [data-demo-stage]",
		top.stageIframes === 0 && !top.iframe,
		`state=${top.state} · iframes=${top.stageIframes}`,
	);
	check("top · no request under /app/", topAppRequests === 0, `${topAppRequests} requests`);

	const scrolledAt = Date.now();
	await scrollToPreview(page);
	const mounted = await waitForSnapshot(page, snapshot => snapshot.iframe, MOUNT_TIMEOUT_MS);
	check(
		"scroll · iframe mounts with no click",
		mounted.ok,
		mounted.ok ? `${Date.now() - scrolledAt} ms after scrollIntoView` : "no iframe after 30 s",
	);

	const ready = await waitForSnapshot(page, snapshot => snapshot.state === "ready", READY_TIMEOUT_MS);
	check(
		"scroll · [data-demo-embed][data-state] reaches ready",
		ready.ok,
		ready.ok ? `state=ready · ${Date.now() - scrolledAt} ms after scrollIntoView` : `state=${ready.snapshot.state}`,
	);
	await shot(page, "02-ready.png");

	const tabs = [
		{
			view: "chat",
			name: "tab chat · transcript",
			matches: snapshot => snapshot.transcript > 0 && snapshot.entries > 0 && snapshot.composer > 0,
			detail: snapshot => `.gui-transcript=${snapshot.transcript} .tr-entry=${snapshot.entries}`,
		},
		{
			view: "files",
			name: "tab files · file workspace",
			matches: snapshot =>
				snapshot.filePane > 0 &&
				snapshot.treeRows > 0 &&
				snapshot.fileNames.includes("README.md") &&
				snapshot.treeToggle > 0,
			detail: snapshot => `README preview · tree mounted (${snapshot.treeRows} rows) · toggle=${snapshot.treeToggle}`,
		},
		{
			view: "board",
			name: "tab board · board surface",
			matches: snapshot => snapshot.board > 0 && snapshot.boardHome > 0,
			detail: snapshot => `.gui-board=${snapshot.board} .gui-board-home=${snapshot.boardHome}`,
		},
		{
			view: "welcome",
			name: "tab welcome · composer",
			matches: snapshot => snapshot.welcome > 0 && snapshot.welcomeInput > 0 && snapshot.textareas > 0,
			detail: snapshot =>
				`.gui-welcome=${snapshot.welcome} .gui-welcome-input=${snapshot.welcomeInput} textarea=${snapshot.textareas}`,
		},
	];

	for (const [index, tab] of tabs.entries()) {
		await page.evaluate(view => document.querySelector(`[data-demo-view="${view}"]`)?.click(), tab.view);
		const result = await waitForSnapshot(page, tab.matches, TAB_TIMEOUT_MS);
		const detail = tab.detail(result.snapshot);
		check(tab.name, result.ok, result.ok ? `${detail} · ${result.elapsed} ms` : detail);
		await shot(page, `0${index + 3}-${tab.view}.png`);

		if (tab.view !== "files" || !result.ok) continue;
		// Opening the demo README collapses the tree into the preview's drawer
		// (the app's own behaviour); expand it with the app's toggle so the
		// check proves the rows render, not just that they are mounted.
		await page.evaluate(() => {
			const doc = document.querySelector("[data-demo-stage] iframe")?.contentDocument;
			doc?.querySelector(".gui-filepane-tree-toggle")?.click();
		});
		const expanded = await waitForSnapshot(
			page,
			snapshot =>
				snapshot.treeOpen &&
				snapshot.treeWidth > 100 &&
				snapshot.visibleTreeRows > 0 &&
				snapshot.visibleFileNames.includes("README.md"),
			10_000,
		);
		const expandedSnapshot = expanded.snapshot;
		const expandedWidth = Math.round(expandedSnapshot.treeWidth);
		const expandedNames = expandedSnapshot.visibleFileNames.slice(0, 6).join(", ");
		check(
			"tab files · file tree expands",
			expanded.ok,
			expanded.ok
				? `${expandedSnapshot.visibleTreeRows} rows · ${expandedWidth} px · ${expandedNames}`
				: `treeOpen=${expandedSnapshot.treeOpen} width=${expandedWidth} visible rows=${expandedSnapshot.visibleTreeRows}`,
		);
		await shot(page, `0${index + 3}-files-tree.png`);
	}

	const daemonRequests = net.requests.filter(entry => entry.url.includes(":8300"));
	check(
		"network · no request to a daemon on :8300",
		daemonRequests.length === 0,
		daemonRequests.length === 0 ? "0 requests" : daemonRequests.slice(0, 3).join(", "),
	);

	const failures = [...net.failedRequests, ...net.badResponses];
	const unexpected = failures.filter(entry => !pathOf(entry.url).endsWith("/favicon.ico"));
	check(
		"network · only /favicon.ico failed",
		unexpected.length === 0,
		unexpected.length === 0
			? failures.length === 0
				? "no failed requests"
				: failures.map(entry => `${pathOf(entry.url)} (${entry.detail})`).join(", ")
			: unexpected.map(entry => `${entry.url} (${entry.detail})`).join(", "),
	);

	// The artifact is the page's whole cost. A document fetched twice (once to
	// probe it, once as the frame) is a round trip in front of the boot; a
	// chunk fetched twice is a waterfall or a broken cache key.
	const artifactRequests = net.requests.filter(entry => entry.path.startsWith("/app/"));
	const documentFetches = artifactRequests.filter(entry => entry.path === "/app/index.html").length;
	check(
		"network · artifact document fetched once",
		documentFetches === 1,
		`${documentFetches} request(s) for /app/index.html`,
	);

	const counts = new Map();
	for (const entry of artifactRequests) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
	const repeated = [...counts].filter(([, count]) => count > 1);
	check(
		"network · every /app/ file fetched once",
		repeated.length === 0,
		repeated.length === 0
			? `${counts.size} files`
			: repeated.map(([file, count]) => `${file} ×${count}`).join(", "),
	);

	// The shell's chunks are one module graph: they must be issued together,
	// not discovered one after another.
	const shellChunks = artifactRequests.filter(
		entry => entry.path.endsWith(".js") && !entry.path.startsWith("/app/plugins/"),
	);
	const chunkSpread = Math.max(...shellChunks.map(entry => entry.at)) - Math.min(...shellChunks.map(entry => entry.at));
	check(
		"network · shell chunks requested together",
		shellChunks.length > 1 && chunkSpread <= 1000,
		`${shellChunks.length} chunks · ${chunkSpread} ms spread`,
	);

	// The renderer is authored at 1440x900 and scaled; a stale transform crops
	// it or leaves it small inside its stage.
	for (const width of [1024, 848, 1440]) {
		await page.setViewport({ width, height: VIEWPORT.height });
		const scaled = await waitForScale(page);
		check(`scale · ${width} px viewport`, scaled.ok, scaleDetail(scaled.geometry));
		if (width === 848) await shot(page, "07-scale-848.png");
	}

	await page.click("[data-demo-fullscreen]");
	const entered = await waitForCondition(async () => Boolean((await demoGeometry(page))?.fullscreen), 5000);
	const fullscreen = await waitForScale(page, 3000);
	check(
		"scale · fullscreen",
		entered && fullscreen.ok,
		entered ? scaleDetail(fullscreen.geometry) : "fullscreen never engaged",
	);
	await shot(page, "08-fullscreen.png");
	await page.evaluate(() => document.exitFullscreen?.());
	await sleep(500);

	// Scrolling past the preview repeatedly and cycling the tabs must reuse the
	// one mounted frame: a second observer or timer would show up as another
	// mount or another state transition.
	for (let i = 0; i < 5; i++) {
		await page.evaluate(() => window.scrollTo(0, 0));
		await sleep(80);
		await scrollToPreview(page);
		await sleep(80);
	}
	for (let i = 0; i < 12; i++) {
		await page.evaluate(index => document.querySelectorAll("[data-demo-view]")[index % 4].click(), i);
		await sleep(100);
	}
	await sleep(1200);

	const storm = await demoSnapshot(page);
	const transitions = storm.states.filter(state => state !== "idle");
	check(
		"mount · one frame and one transition per state under a scroll storm",
		storm.mounts === 1 && storm.stageIframes === 1 && transitions.join(",") === "loading,ready",
		`mounts=${storm.mounts} · iframes=${storm.stageIframes} · states=${storm.states.join("→")}`,
	);

	const final = await demoSnapshot(page);
	check(
		"fallback · never visible",
		!final.fallbackSeen && !final.fallbackVisible,
		final.fallbackSeen || final.fallbackVisible ? "fallback was shown" : "hidden throughout",
	);
	check(
		"loading · never visible after ready",
		!final.loadingAfterReady,
		final.loadingAfterReady ? "loading overlay returned after ready" : "stayed hidden",
	);

	if (net.pageErrors.length > 0) console.log(`      page errors: ${net.pageErrors.length} · ${net.pageErrors[0].slice(0, 160)}`);

	const artifactBytes = artifactRequests.reduce((sum, entry) => sum + entry.bytes, 0);
	console.log(
		`      artifact · ${artifactRequests.length} requests · ${(artifactBytes / 1024 / 1024).toFixed(2)} MiB · ready at ${ready.elapsed} ms after scroll`,
	);

	// A reduced-motion visitor still gets the product; only the motion goes.
	{
		const page = await openPage();
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
		await installProbes(page);
		await scrollToPreview(page);
		const ready = await waitForSnapshot(page, snapshot => snapshot.state === "ready", READY_TIMEOUT_MS);
		const animations = await page.evaluate(() =>
			document
				.getAnimations()
				.filter(animation => animation.effect?.target?.closest?.(".mp-demo"))
				.map(animation => animation.animationName ?? animation.transitionProperty ?? "animation"),
		);
		const scaled = await waitForScale(page, 3000);
		check(
			"reduced motion · preview ready with no animation",
			ready.ok && animations.length === 0 && scaled.ok,
			`state=${ready.snapshot.state} · animations=${animations.length ? animations.join(", ") : "none"} · ${scaleDetail(scaled.geometry)}`,
		);
		await shot(page, "09-reduced-motion.png");
		await page.close();
	}

	// A deploy without the artifact: the frame is a 404 page, which the load
	// handler must recognise without a separate probe request.
	{
		const page = await openPage();
		let attempts = 0;
		await page.setRequestInterception(true);
		page.on("request", request => {
			if (pathOf(request.url()) === "/app/index.html") {
				attempts += 1;
				request.respond({ status: 404, contentType: "text/plain", body: "not found" });
				return;
			}
			request.continue();
		});
		await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
		await installProbes(page);
		await scrollToPreview(page);
		const failed = await waitForSnapshot(page, snapshot => snapshot.state === "error", FAILURE_TIMEOUT_MS);
		const panel = await page.evaluate(() => {
			const element = document.querySelector("[data-demo-fallback]");
			const style = getComputedStyle(element);
			return {
				visible: !element.hidden && style.display !== "none" && element.getClientRects().length > 0,
				title: element.querySelector("h3")?.textContent.trim() ?? "",
				retry: element.querySelector("[data-demo-retry]")?.textContent.trim() ?? "",
				href: element.querySelector("a")?.getAttribute("href") ?? "",
				status: document.querySelector("[data-demo-status]")?.textContent.trim() ?? "",
				loading: document.querySelector("[data-demo-loading]").getClientRects().length > 0,
			};
		});
		await shot(page, "10-fallback-404.png");
		check(
			"fallback · /app/index.html 404 shows copy and actions",
			failed.ok &&
				panel.visible &&
				!panel.loading &&
				panel.title.length > 0 &&
				panel.retry.length > 0 &&
				panel.href === "./app/index.html",
			failed.ok
				? `${failed.elapsed} ms · title="${panel.title}" · retry="${panel.retry}" · link=${panel.href} · status="${panel.status}"`
				: `state=${failed.snapshot.state}`,
		);

		// One silent retry, then the visitor's own: a persistent failure must
		// settle, not spin.
		await sleep(4000);
		const settled = attempts;
		await page.click("[data-demo-retry]");
		await sleep(4000);
		const afterRetry = await page.evaluate(() => document.querySelector("[data-demo-embed]").dataset.state);
		check(
			"fallback · retry is bounded and returns to the fallback",
			settled <= 2 && attempts <= 4 && afterRetry === "error",
			`${settled} attempt(s) after the silent retry · ${attempts} after a click · state=${afterRetry}`,
		);
		await page.close();
	}

	// A chunk that dies mid-load leaves #root empty; the page must not wait out
	// its 90 s boot budget to say so.
	{
		const page = await openPage();
		// Resolve the entry chunk from the served artifact: hardcoding a
		// hashed name silently stops blocking after any rebuild.
		const artifactHtml = await (await fetch(`${baseUrl}app/index.html`)).text();
		const entryMatch = /<script type="module" src="\.\/([^"]+)\.js"/.exec(artifactHtml);
		const entryPath = entryMatch ? `/app/${entryMatch[1]}.js` : null;
		if (!entryPath) throw new Error("verify-site-preview: no module entry in app/index.html");
		await blockArtifact(page, entryPath);
		await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
		await installProbes(page);
		await scrollToPreview(page);
		const failed = await waitForSnapshot(page, snapshot => snapshot.state === "error", STALL_TIMEOUT_MS);
		check(
			"fallback · a chunk that fails mid-load reaches the fallback",
			failed.ok && failed.snapshot.fallbackVisible,
			failed.ok ? `${failed.elapsed} ms · fallback visible` : `state=${failed.snapshot.state} after 45 s`,
		);
		await shot(page, "11-fallback-chunk.png");
		await page.close();
	}
} catch (error) {
	console.error(`[site-preview] ${error?.stack ?? error}`);
	process.exitCode = 1;
} finally {
	await cleanup();
}

const failed = results.filter(result => !result.ok).length;
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n${results.length - failed}/${results.length} checks passed · ${seconds} s`);
if (failed > 0) {
	console.log(`[site-preview] FAIL · ${failed} check(s) failed`);
	process.exitCode = 1;
}
