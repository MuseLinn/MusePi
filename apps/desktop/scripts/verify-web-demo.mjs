#!/usr/bin/env bun
/**
 * End-to-end verification for the marketing preview in `web/app/`.
 *
 * Serves the built artifact on a loopback port, boots the real renderer in
 * headless Edge and checks the demo contract: the shell paints, the welcome
 * composer mounts, a demo session renders its transcript, and nothing leaves
 * for a real daemon. The fixture transport targets `ws://127.0.0.1:9` (a dead
 * port) and replaces `window.WebSocket`, so a demo whose fixtures fail to
 * install can only fail this check — it can never reach a daemon on 8300.
 *
 * Build the artifact first: `bun run build:web-demo` in apps/desktop.
 *
 * Usage:
 *   bun apps/desktop/scripts/verify-web-demo.mjs
 *   bun apps/desktop/scripts/verify-web-demo.mjs --edge <path> --app <dir> --shots <dir>
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_DIR = resolve(REPO_ROOT, flag("--app", "web/app"));
const EDGE = flag("--edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
const SHOTS = resolve(REPO_ROOT, flag("--shots", ".tmp/verify-web-demo"));

const REAL_DAEMON_PORT = "8300";
const DEAD_URL = "ws://127.0.0.1:9/demo";
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const BOOT_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 20_000;
const HARD_TIMEOUT_MS = 120_000;
const MIME = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".woff2": "font/woff2",
};

if (!existsSync(join(APP_DIR, "index.html"))) {
	console.error(`verify:web-demo: ${join(APP_DIR, "index.html")} is missing`);
	console.error("  run `bun run build:web-demo` in apps/desktop first");
	process.exit(2);
}
if (!existsSync(EDGE)) {
	console.error(`verify:web-demo: Edge not found at ${EDGE}`);
	process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

const manifest = (() => {
	try {
		return JSON.parse(readFileSync(join(APP_DIR, "MANIFEST.json"), "utf8"));
	} catch {
		return null;
	}
})();
const artifactBytes = manifest?.totalBytes ?? statSync(join(APP_DIR, "index.html")).size;
const artifactFiles = manifest?.fileCount ?? null;

const checks = [];
const record = (name, ok, detail) => {
	checks.push({ name, ok, detail });
	return ok;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, description, timeoutMs = STEP_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${description}`);
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const pathname = decodeURIComponent(new URL(request.url).pathname);
		const file = join(APP_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
		if (!file.startsWith(APP_DIR)) return new Response("forbidden", { status: 403 });
		const body = Bun.file(file);
		if (!(await body.exists())) return new Response("not found", { status: 404 });
		return new Response(body, { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
	},
});

const origin = `http://127.0.0.1:${server.port}/`;
const started = performance.now();
// A renderer that never settles can leave `browser.close()` pending for minutes;
// the watchdog turns that into a failure instead of a hung check.
const watchdog = setTimeout(() => {
	console.error(`verify:web-demo: aborted after ${HARD_TIMEOUT_MS / 1000}s`);
	process.exit(1);
}, HARD_TIMEOUT_MS);
watchdog.unref();
let browser;
let page;
const requests = [];
const failedRequests = [];
const pageErrors = [];
const realSockets = [];

try {
	browser = await puppeteer.launch({
		executablePath: EDGE,
		headless: true,
		args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--hide-scrollbars", "--force-color-profile=srgb"],
	});
	page = await browser.newPage();
	await page.setViewport(VIEWPORT);
	page.on("pageerror", error => pageErrors.push(String(error?.message ?? error)));
	page.on("console", message => {
		if (message.type() !== "error") return;
		if (message.location()?.url.endsWith("/favicon.ico")) return;
		pageErrors.push(message.text());
	});
	page.on("request", request => requests.push(request.url()));
	page.on("requestfailed", request => failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? "failed"})`));
	page.on("response", response => {
		if (response.status() >= 400) failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
	});
	const cdp = await page.createCDPSession();
	await cdp.send("Network.enable");
	cdp.on("Network.webSocketCreated", event => realSockets.push(event.request.url));

	await page.goto(origin, { waitUntil: "load", timeout: BOOT_TIMEOUT_MS });

	let shellOk = false;
	try {
		await waitFor(() => page.$(".gui-shell"), "the app shell");
		const nav = await waitFor(
			() =>
				page.evaluate(() => {
					const items = [...document.querySelectorAll(".gui-side-menu .gui-menu-item")]
						.map(item => item.textContent?.trim() ?? "")
						.filter(Boolean);
					return items.length > 0 ? items : null;
				}),
			"the sidebar nav",
		);
		const status = await waitFor(
			() => page.evaluate(() => document.querySelector(".gui-sidebar-footer")?.innerText.trim() ?? ""),
			"the status bar",
		);
		const header = await page.evaluate(() => document.querySelector(".gui-header")?.innerText.trim() ?? "");
		shellOk = record(
			"real shell renders",
			nav.length >= 4 && status.length > 0 && header.length > 0,
			`sidebar nav ${nav.length} items, status bar "${status.replace(/\s+/g, " ")}"`,
		);
	} catch (error) {
		record("real shell renders", false, error instanceof Error ? error.message : String(error));
	}

	let welcomeOk = false;
	try {
		await waitFor(() => page.$(".gui-welcome textarea.gui-ta-welcome"), "the welcome composer");
		const composer = await page.evaluate(() => {
			const element = document.querySelector(".gui-welcome textarea.gui-ta-welcome");
			return {
				placeholder: element?.getAttribute("placeholder") ?? "",
				height: element?.getBoundingClientRect().height ?? 0,
			};
		});
		welcomeOk = record(
			"welcome composer mounts",
			composer.placeholder.length > 0 && composer.height > 0,
			`textarea.gui-ta-welcome "${composer.placeholder}"`,
		);
		await page.screenshot({ path: join(SHOTS, "welcome.png") });
	} catch (error) {
		record("welcome composer mounts", false, error instanceof Error ? error.message : String(error));
	}

	if (!shellOk) {
		record("demo session renders its transcript", false, "skipped: the shell did not render");
	} else {
		try {
			const rows = await waitFor(
				() =>
					page.evaluate(() =>
						[...document.querySelectorAll(".gui-session-row")].map(
							row => row.querySelector(".gui-session-title")?.textContent?.trim() ?? "",
						),
					),
				"the demo session list",
			);
			const index = rows.findIndex(title => /128/.test(title));
			const title = rows[index >= 0 ? index : 0];
			await page.evaluate(
				target => document.querySelectorAll(".gui-session-row")[target]?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
				index >= 0 ? index : 0,
			);
			await waitFor(() => page.$(".gui-transcript .tr-entry"), "the transcript");
			const transcript = await page.evaluate(() => document.querySelector(".gui-transcript")?.innerText.trim() ?? "");
			const entries = await page.evaluate(() => document.querySelectorAll(".gui-transcript .tr-entry").length);
			const header = await page.evaluate(() => document.querySelector(".gui-header--session")?.innerText.trim() ?? "");
			const composer = await page.$(".gui-composer");
			const ok = Boolean(composer) && entries >= 1 && transcript.length > 100 && header.includes(title);
			record(
				"demo session renders its transcript",
				ok,
				`"${title}" → ${entries} entries, ${transcript.length} chars, composer ${composer ? "present" : "missing"}`,
			);
			await page.screenshot({ path: join(SHOTS, "session.png") });
		} catch (error) {
			record("demo session renders its transcript", false, error instanceof Error ? error.message : String(error));
		}
	}

	const daemonHits = requests.filter(url => new URL(url).port === REAL_DAEMON_PORT);
	const unexpectedFailures = failedRequests.filter(url => !new URL(url.split(" (")[0]).pathname.endsWith("/favicon.ico"));
	record(
		"no request targets the real daemon",
		daemonHits.length === 0 && unexpectedFailures.length === 0,
		`${requests.length} requests, ${daemonHits.length} to :${REAL_DAEMON_PORT}, ${failedRequests.length} failed (${unexpectedFailures.join(", ") || "only /favicon.ico"})`,
	);

	const storedUrl = await page.evaluate(() => {
		try {
			return localStorage.getItem("musepi-gui-url");
		} catch {
			return null;
		}
	});
	record(
		"page works with the socket target unreachable",
		storedUrl === DEAD_URL && realSockets.length === 0 && shellOk && welcomeOk,
		`${realSockets.length} real WebSocket connections, target ${storedUrl ?? "unknown"}`,
	);
} catch (error) {
	record("demo boots", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	if (browser) {
		const closed = await Promise.race([browser.close().then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
		if (!closed) browser.process()?.kill("SIGKILL");
	}
	server.stop(true);
	clearTimeout(watchdog);
}

const passed = checks.filter(check => check.ok).length;
const width = Math.max(...checks.map(check => check.name.length));
const size = `${(artifactBytes / 1024 / 1024).toFixed(2)} MiB${artifactFiles === null ? "" : `, ${artifactFiles} files`}`;
console.log(`verify:web-demo  ${APP_DIR.replace(REPO_ROOT, "").replace(/\\/g, "/")} (${size})`);
for (const check of checks) console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
if (pageErrors.length > 0) console.log(`  NOTE  renderer errors: ${pageErrors.slice(0, 5).join(" | ")}`);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const outcome = passed === checks.length ? "PASS" : "FAIL";
console.log(`verify:web-demo  ${outcome} ${passed}/${checks.length}  (${seconds}s, screenshots ${SHOTS.replace(REPO_ROOT, "").replace(/\\/g, "/")})`);
process.exitCode = passed === checks.length ? 0 : 1;
