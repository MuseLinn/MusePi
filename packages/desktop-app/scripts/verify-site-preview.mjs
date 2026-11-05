#!/usr/bin/env bun
/**
 * End-to-end check for the marketing preview's self-loading behaviour.
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
let page;

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
function demoSnapshot() {
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
		};
	});
}

async function waitForSnapshot(predicate, timeoutMs) {
	const started = Date.now();
	let snapshot = await demoSnapshot();
	while (!predicate(snapshot)) {
		if (Date.now() - started > timeoutMs) return { ok: false, elapsed: Date.now() - started, snapshot };
		await sleep(150);
		snapshot = await demoSnapshot();
	}
	return { ok: true, elapsed: Date.now() - started, snapshot };
}

async function shot(name) {
	const file = path.join(shotsDir, name);
	await page.screenshot({ path: file });
	const kib = (readFileSync(file).length / 1024).toFixed(0);
	console.log(`      shot ${path.relative(repoRoot, file)}  ${kib} KiB`);
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
	page = await browser.newPage();
	await page.setViewport(VIEWPORT);

	const requests = [];
	const failedRequests = [];
	const badResponses = [];
	const pageErrors = [];
	page.on("request", request => requests.push(request.url()));
	page.on("requestfailed", request =>
		failedRequests.push({ url: request.url(), detail: request.failure()?.errorText ?? "unknown" }),
	);
	page.on("response", response => {
		if (response.status() >= 400) badResponses.push({ url: response.url(), detail: `HTTP ${response.status()}` });
	});
	page.on("pageerror", error => pageErrors.push(String(error?.message ?? error)));

	// The fallback is only ever flipped by the page's own error path. Record the
	// first visible frame on the document so the check covers the whole run,
	// not just the end state.
	await page.evaluateOnNewDocument(() => {
		const visible = element => {
			if (!element || element.hidden) return false;
			const style = getComputedStyle(element);
			return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
		};
		const probe = () => {
			if (visible(document.querySelector("[data-demo-fallback]"))) {
				document.documentElement.dataset.demoFallbackSeen = "1";
			}
		};
		const start = () => {
			probe();
			new MutationObserver(probe).observe(document.documentElement, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ["hidden", "style", "class", "data-state"],
			});
			setInterval(probe, 150);
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
		else start();
	});

	await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
	await sleep(500);

	const top = await demoSnapshot();
	const topAppRequests = requests.filter(url => pathOf(url).startsWith("/app/")).length;
	await shot("01-top.png");
	check(
		"top · no iframe in [data-demo-stage]",
		top.stageIframes === 0 && !top.iframe,
		`state=${top.state} · iframes=${top.stageIframes}`,
	);
	check("top · no request under /app/", topAppRequests === 0, `${topAppRequests} requests`);

	const scrolledAt = Date.now();
	await page.evaluate(() => document.getElementById("preview")?.scrollIntoView({ block: "center" }));
	const mounted = await waitForSnapshot(snapshot => snapshot.iframe, MOUNT_TIMEOUT_MS);
	check(
		"scroll · iframe mounts with no click",
		mounted.ok,
		mounted.ok ? `${Date.now() - scrolledAt} ms after scrollIntoView` : "no iframe after 30 s",
	);

	const ready = await waitForSnapshot(snapshot => snapshot.state === "ready", READY_TIMEOUT_MS);
	check(
		"scroll · [data-demo-embed][data-state] reaches ready",
		ready.ok,
		ready.ok ? `state=ready · ${Date.now() - scrolledAt} ms after scrollIntoView` : `state=${ready.snapshot.state}`,
	);
	await shot("02-ready.png");

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
		const result = await waitForSnapshot(tab.matches, TAB_TIMEOUT_MS);
		const detail = tab.detail(result.snapshot);
		check(tab.name, result.ok, result.ok ? `${detail} · ${result.elapsed} ms` : detail);
		await shot(`0${index + 3}-${tab.view}.png`);

		if (tab.view !== "files" || !result.ok) continue;
		// Opening the demo README collapses the tree into the preview's drawer
		// (the app's own behaviour); expand it with the app's toggle so the
		// check proves the rows render, not just that they are mounted.
		await page.evaluate(() => {
			const doc = document.querySelector("[data-demo-stage] iframe")?.contentDocument;
			doc?.querySelector(".gui-filepane-tree-toggle")?.click();
		});
		const expanded = await waitForSnapshot(
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
		await shot(`0${index + 3}-files-tree.png`);
	}

	const daemonRequests = requests.filter(url => url.includes(":8300"));
	check(
		"network · no request to a daemon on :8300",
		daemonRequests.length === 0,
		daemonRequests.length === 0 ? "0 requests" : daemonRequests.slice(0, 3).join(", "),
	);

	const failures = [...failedRequests, ...badResponses];
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

	const final = await demoSnapshot();
	check(
		"fallback · never visible",
		!final.fallbackSeen && !final.fallbackVisible,
		final.fallbackSeen || final.fallbackVisible ? "fallback was shown" : "hidden throughout",
	);

	if (pageErrors.length > 0) console.log(`      page errors: ${pageErrors.length} · ${pageErrors[0].slice(0, 160)}`);
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
