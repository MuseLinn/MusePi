#!/usr/bin/env bun
/** Real Electron verification for the lazy PDFium reader and quote anchors.
 * Run through scripts/dev-smoke.ts so sessions and daemon state stay isolated. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer-core";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const sourcePdf = path.join(repoRoot, ".tmp", "pdf-source", "main_zh.pdf");
const fixture = path.join(repoRoot, ".tmp", `pdf-e2e-${process.pid}`);
const pdfPath = path.join(fixture, "main_zh.pdf");
const otherPath = path.join(fixture, "other.txt");
const reportPath = path.join(repoRoot, ".tmp", "pdf-e2e-report.json");
const screenshotPath = path.join(repoRoot, ".tmp", "pdf-e2e.png");
const report = { assertions: [], runtimeErrors: [], startupWarnings: [], pdfLogs: [] };
const pdfWorkers = [];
const destroyedPdfWorkers = new Set();
let acceptingStartupWarnings = true;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(name, value, details) {
	report.assertions.push({ name, pass: Boolean(value), ...(details === undefined ? {} : { details }) });
	if (!value) throw new Error(`Assertion failed: ${name}${details === undefined ? "" : ` — ${JSON.stringify(details)}`}`);
}

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TCP port");
	const port = address.port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function waitFor(fn, description, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await sleep(150);
	}
	throw new Error(`Timed out: ${description}`);
}

function daemonRequest(port, method, params) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		const timeout = setTimeout(() => {
			socket.close();
			reject(new Error(`Timed out: ${method}`));
		}, 30_000);
		socket.onopen = () => socket.send(JSON.stringify({ id: method, method, params }));
		socket.onmessage = event => {
			const message = JSON.parse(String(event.data));
			if (message.id !== method) return;
			clearTimeout(timeout);
			socket.close();
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		};
		socket.onerror = () => {
			clearTimeout(timeout);
			reject(new Error(`Could not connect for ${method}`));
		};
	});
}

if (!fs.existsSync(sourcePdf)) throw new Error(`Copy the real PDF to ${sourcePdf} before running this verification`);
fs.mkdirSync(fixture, { recursive: true });
fs.copyFileSync(sourcePdf, pdfPath);
const corruptPath = path.join(fixture, "corrupt-synthetic.pdf");
const encryptedPath = path.join(fixture, "encrypted-synthetic.pdf");
fs.writeFileSync(corruptPath, "%PDF-1.7\nMusePi synthetic corrupt fixture\n%%EOF\n");
fs.copyFileSync(path.join(repoRoot, ".tmp", "pdf-source", "encrypted-synthetic.pdf"), encryptedPath);
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "pdf-e2e-fixture", private: true }));
fs.writeFileSync(otherPath, "Reader closed\n");

let electron;
let browser;
let daemonPort;
let electronOutput = "";
try {
	const cdpPort = await freePort();
	daemonPort = await freePort();
	const electronBinary = path.join(packageRoot, "node_modules", "electron", "dist", "electron.exe");
	const mainPath = path.join(packageRoot, "electron", "main.cjs");
	const appVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
	const agentDir = path.join(fixture, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			"    baseUrl: http://127.0.0.1:1/v1",
			"    apiKey: sk-fake",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-pdf",
			"        name: Fake PDF",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	const isolatedEnv = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
		HOME: fixture,
		USERPROFILE: fixture,
		PI_CODING_AGENT_DIR: agentDir,
		MUSEPI_VERSION: appVersion,
		MUSEPI_GUI_USER_DATA: path.join(fixture, "electron-data"),
		MUSEPI_CDP_PORT: String(cdpPort),
		MUSEPI_GUI_DAEMON_PORT: String(daemonPort),
		OMP_NO_AUTO_UPDATE: "1",
		OMP_SOFTWARE_GL: "1",
	};
	electron = spawn(electronBinary, ["--no-sandbox", `--remote-debugging-port=${cdpPort}`, mainPath], {
		cwd: fixture,
		stdio: ["ignore", "pipe", "pipe"],
		env: isolatedEnv,
	});
	for (const stream of [electron.stdout, electron.stderr]) {
		stream.on("data", chunk => {
			electronOutput = (electronOutput + chunk.toString()).slice(-12_000);
		});
	}
	electron.on("error", error => {
		electronOutput += `\n${error.stack ?? error.message}`;
	});
	await waitFor(async () => {
		try {
			return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok;
		} catch {
			return false;
		}
	}, "Electron CDP", 35_000);
	browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null });
	const page = await waitFor(async () => {
		const pages = await browser.pages();
		return pages.find(candidate => candidate.url().includes("dist/index.html")) ?? null;
	}, "desktop renderer");
	page.on("pageerror", error => report.runtimeErrors.push(error.message));
	page.on("console", message => {
		const text = message.text();
		if (/pdf|worker|wasm|document/i.test(text)) report.pdfLogs.push(`${message.type()}: ${text}`.slice(0, 2_000));
		if (message.type() !== "error") return;
		const startupRefusal = acceptingStartupWarnings && text.includes(`ws://127.0.0.1:${daemonPort}`) && text.includes("ERR_CONNECTION_REFUSED");
		report[startupRefusal ? "startupWarnings" : "runtimeErrors"].push(text);
	});
	page.on("workercreated", worker => {
		pdfWorkers.push(worker);
		report.pdfLogs.push(`workercreated: ${worker.url()}`);
	});
	page.on("workerdestroyed", worker => {
		destroyedPdfWorkers.add(worker);
		report.pdfLogs.push(`workerdestroyed: ${worker.url()}`);
	});
	page.on("requestfailed", request => report.pdfLogs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
	await page.evaluateOnNewDocument(() => {
		window.addEventListener("musepi-gui-quote-append", event => {
			window.__lastPdfQuote = event.detail?.displayContext;
		});
	});
	try {
		await waitFor(() => page.$(".gui-header"), "GUI header", 35_000);
	} catch {
		report.startupWarnings.push("Initial GUI header wait timed out; reloaded after the isolated daemon startup race");
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(() => page.$(".gui-header"), "GUI header after startup reload", 35_000);
	}
	await page.evaluate(() => localStorage.setItem("musepi-gui-onboarding-done", "1"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitFor(() => page.$(".gui-header"), "GUI header after onboarding setup", 25_000);
	await sleep(800);
	acceptingStartupWarnings = false;
	if (!(await page.$(".gui-session-row"))) {
		const created = await daemonRequest(daemonPort, "session.create", {
			cwd: fixture,
			autoTitle: false,
			modelPattern: "fake/fake-pdf",
		});
		report.sessionId = created.sessionId;
		await waitFor(() => page.evaluate(() => Boolean(document.querySelector(".gui-session-row"))), "created session row", 25_000);
		await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
		await waitFor(() => page.$(".gui-transcript"), "selected session", 15_000);
	}
	const openFile = async (filePath, extra = {}) => {
		await page.evaluate((target, detail) => {
			window.dispatchEvent(new CustomEvent("musepi-open-file", { detail: { path: target, ...detail } }));
		}, filePath, extra);
	};
	const activatePdfAction = async command => {
		const selector = `.gui-pdf-toolbar [data-pdf-overflow-item="${command}"]`;
		const visible = await page.$eval(selector, element => element.getClientRects().length > 0).catch(() => false);
		if (visible) {
			await page.click(selector);
			return "toolbar";
		}
		await page.click("[data-pdf-more]");
		await waitFor(() => page.$(`.gui-pdf-overflow [data-pdf-menu-item="${command}"]`), `overflow action ${command}`);
		await sleep(200);
		await page.click(`.gui-pdf-overflow [data-pdf-menu-item="${command}"]`);
		return "more-menu";
	};
	// Install on the current document too. The isolated shell can recreate its
	// renderer during daemon startup, before the PDF test begins.
	await page.evaluate(() => {
		window.addEventListener("musepi-gui-quote-append", event => {
			window.__lastPdfQuote = event.detail?.displayContext;
		});
	});

	const readPdfLayout = () => page.evaluate(() => {
		const metrics = selector => {
			const element = document.querySelector(selector);
			if (!element) return null;
			const bounds = element.getBoundingClientRect();
			return {
				clientWidth: element.clientWidth,
				clientHeight: element.clientHeight,
				offsetWidth: element.offsetWidth,
				offsetHeight: element.offsetHeight,
				scrollWidth: element.scrollWidth,
				scrollHeight: element.scrollHeight,
				childElementCount: element.childElementCount,
				bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
				display: getComputedStyle(element).display,
				visibility: getComputedStyle(element).visibility,
			};
		};
		return {
			window: { width: window.innerWidth, height: window.innerHeight },
			reader: metrics(".gui-pdf-reader"),
			content: metrics(".gui-pdf-content"),
			viewport: metrics(".gui-pdf-viewport"),
			scroller: metrics(".gui-pdf-viewport > div"),
			pdfPages: document.querySelectorAll(".gui-pdf-page").length,
			pdfImages: document.querySelectorAll(".gui-pdf-page img").length,
		};
	});
	const workerBaseline = new Set(page.workers());
	const startedAt = Date.now();
	await openFile(pdfPath);
	await waitFor(async () => {
		const image = await page.$('.gui-pdf-page[data-pdf-page="0"] img');
		if (image) return image;
		report.firstPagePendingLayout = await readPdfLayout();
		return null;
	}, "first PDF page image", 60_000);
	report.firstPageLayout = await readPdfLayout();
	report.firstPageMs = Date.now() - startedAt;
	report.firstRender = await page.evaluate(() => ({
		pageCount: document.querySelector(".gui-pdf-page-count")?.textContent ?? "",
		renderedPages: [...document.querySelectorAll(".gui-pdf-page")].map(element => Number(element.getAttribute("data-pdf-page"))),
		images: document.querySelectorAll(".gui-pdf-page img").length,
	}));
	report.firstRender.workerCount = pdfWorkers.filter(worker => !workerBaseline.has(worker)).length;
	assert("the real 27.9 MB PDF renders its first page", report.firstRender.images > 0, report.firstRender);
	assert("the reader knows all 28 pages before rendering every page", report.firstRender.pageCount.includes("28"), report.firstRender);
	assert("the first screen renders only the visible page range", report.firstRender.images < 28, report.firstRender);
	assert("PDFium runs in a Worker", report.firstRender.workerCount > 0, report.firstRender);
	report.toolbar = await waitFor(() => page.evaluate(() => {
		const toolbar = document.querySelector(".gui-pdf-toolbar");
		if (!toolbar) return null;
		const bounds = toolbar.getBoundingClientRect();
		const contentRight = bounds.right - Number.parseFloat(getComputedStyle(toolbar).paddingRight);
		const last = [...toolbar.children].filter(element => !element.hidden && !element.classList.contains("gui-pdf-toolbar-spacer")).at(-1);
		const metrics = {
			clientWidth: toolbar.clientWidth,
			scrollWidth: toolbar.scrollWidth,
			contentOverflow: last ? Math.max(0, last.getBoundingClientRect().right - contentRight) : 0,
			height: bounds.height,
			moreVisible: document.querySelector("[data-pdf-more]")?.getClientRects().length > 0,
			overflowCount: [...toolbar.querySelectorAll("[data-pdf-overflow-item]")].filter(element => element.hidden).length,
			pageInputVisible: document.querySelector(".gui-pdf-page-input")?.getClientRects().length > 0,
		};
		return metrics.contentOverflow <= 1 && metrics.height === 36 ? metrics : null;
	}), "single-line PDF toolbar without horizontal overflow");
	assert("PDF toolbar keeps one row without hidden horizontal scrolling", true, report.toolbar);
	assert("narrow PDF toolbar moves secondary actions into More", report.toolbar.moreVisible && report.toolbar.overflowCount > 0, report.toolbar);
	assert("PDF page navigation remains visible", report.toolbar.pageInputVisible, report.toolbar);

	await page.click(".gui-pdf-page-input");
	await page.keyboard.down("Control");
	await page.keyboard.press("a");
	await page.keyboard.up("Control");
	await page.keyboard.type("2");
	await page.keyboard.press("Enter");
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="1"] img'), "page-number navigation");
	assert("page input opens page two", (await page.$eval(".gui-pdf-page-input", element => element.value)) === "2");

	const zoomBefore = await page.$eval(".gui-pdf-zoom-value", element => element.textContent);
	await page.evaluate(() => {
		const button = [...document.querySelectorAll(".gui-pdf-toolbar button")].find(element => ["放大", "Zoom in"].includes(element.getAttribute("title") ?? ""));
		button?.click();
	});
	await waitFor(async () => (await page.$eval(".gui-pdf-zoom-value", element => element.textContent)) !== zoomBefore, "PDF zoom change");
	assert("zoom changes the rendered scale", true);

	report.searchActionSource = await activatePdfAction("search");
	await waitFor(() => page.$(".gui-pdf-search input"), "PDF search input");
	assert("PDF search opens from the visible toolbar or its More menu", true, report.searchActionSource);
	await page.type(".gui-pdf-search input", "散射体姿态调制");
	await page.keyboard.press("Enter");
	report.searchCount = await waitFor(async () => {
		const text = await page.$eval(".gui-pdf-search-count", element => element.textContent ?? "").catch(() => "");
		return /\d+\s*\/\s*[1-9]/.test(text) ? text : null;
	}, "Chinese PDF search results", 60_000);
	assert("Chinese text search returns navigable results", true, report.searchCount);
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".gui-pdf-search")), "search close");
	// EmbedPDF restores the pre-search viewport after closing results. Let that
	// restoration finish before the independent on-demand scrolling check.
	await sleep(500);
	await page.evaluate(() => {
		const viewport = document.querySelector(".gui-pdf-viewport");
		if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
	});
	await waitFor(
		() => page.$eval(".gui-pdf-viewport", element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2),
		"PDF viewport reaches the last page",
	);
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="27"] img'), "last page rendered after scrolling", 60_000);
	report.scrolledRender = await page.evaluate(() => ({
		renderedPages: [...document.querySelectorAll(".gui-pdf-page")].map(element => Number(element.getAttribute("data-pdf-page"))),
		images: document.querySelectorAll(".gui-pdf-page img").length,
	}));
	assert("scrolling renders the last page on demand", report.scrolledRender.renderedPages.includes(27), report.scrolledRender);
	assert("scrolling does not retain images for the whole document", report.scrolledRender.images < 28, report.scrolledRender);

	await page.click(".gui-pdf-page-input");
	await page.keyboard.down("Control");
	await page.keyboard.press("a");
	await page.keyboard.up("Control");
	await page.keyboard.type("1");
	await page.keyboard.press("Enter");
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="0"] img'), "return to first PDF page", 60_000);
	let pageBox = await (await page.$('.gui-pdf-page[data-pdf-page="0"]'))?.boundingBox();
	if (!pageBox) throw new Error("First PDF page has no pointer bounds");
	await waitFor(async () => {
		const next = await (await page.$('.gui-pdf-page[data-pdf-page="0"]'))?.boundingBox();
		const stable = next && pageBox && Math.abs(next.x - pageBox.x) < 0.5 && Math.abs(next.y - pageBox.y) < 0.5;
		pageBox = next;
		return stable;
	}, "first-page scroll position to settle");
	await page.evaluate(() => document.querySelector(".gui-pdf-viewport")?.scrollTo({ top: 0, behavior: "instant" }));
	await sleep(800);
	pageBox = await (await page.$('.gui-pdf-page[data-pdf-page="0"]'))?.boundingBox();
	if (!pageBox) throw new Error("First PDF page lost pointer bounds");
	let selectionStart = null;
	for (const [x, y] of [[100, 50], [150, 50], [60, 250], [60, 280], [100, 85]]) {
		await page.mouse.move(pageBox.x + x, pageBox.y + y);
		await sleep(40);
		const cursor = await page.$eval('.gui-pdf-page[data-pdf-page="0"] > div', element => element.style.cursor);
		if (cursor === "text") {
			selectionStart = { x: pageBox.x + x, y: pageBox.y + y };
			break;
		}
	}
	if (!selectionStart) throw new Error("Could not locate a text glyph on the first PDF page");
	report.selectionPointerOrigin = selectionStart;
	await page.evaluate(() => {
		window.__pdfPointerEvents = [];
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "dragstart"]) {
			document.querySelector('.gui-pdf-page[data-pdf-page="0"]')?.addEventListener(type, event => {
				window.__pdfPointerEvents.push({ type, target: event.target?.tagName, x: event.clientX, y: event.clientY });
			});
		}
	});
	await page.mouse.down();
	await page.mouse.move(pageBox.x + pageBox.width - 45, pageBox.y + Math.min(280, pageBox.height - 30), { steps: 12 });
	await page.mouse.up();
	await waitFor(() => page.$(".gui-select-pop"), "PDF selection toolbar", 15_000);
	await page.hover(".gui-select-pop");
	await sleep(300);
	report.selectionToolbarBounds = await page.$eval(".gui-select-pop", element => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
	});
	assert(
		"expanded PDF selection actions stay inside the window",
		report.selectionToolbarBounds.left >= 0 && report.selectionToolbarBounds.right <= report.selectionToolbarBounds.viewportWidth,
		report.selectionToolbarBounds,
	);
	await page.click(".gui-select-pop-btn");
	const quote = await waitFor(
		() => page.evaluate(() => window.__lastPdfQuote?.kind === "file-quote" && window.__lastPdfQuote.pdf ? window.__lastPdfQuote : null),
		"structured PDF quote",
	);
	report.quote = quote;
	assert("PDF quote carries page and glyph anchors", quote.pdf.startPage >= 1 && quote.pdf.selections.length > 0, quote.pdf);
	assert("PDF quote contains selected text", quote.quote.trim().length > 0, quote.quote);
	assert("composer keeps quote details collapsed behind chips", !(await page.$(".gui-quote-card")));
	await page.click('[data-quote-kind="file-quote"]');
	const quoteLabel = await waitFor(async () => {
		const text = await page.$eval(".gui-quote-context-page", element => element.textContent ?? "").catch(() => "");
		return text.includes(`PDF ${quote.pdf.startPage}-${quote.pdf.endPage}`) ? text : null;
	}, "composer PDF page label");
	assert("composer displays the quoted PDF pages in its reference popup", true, quoteLabel);
	await page.keyboard.press("Escape");

	await openFile(pdfPath, { pdf: quote.pdf, quote: quote.quote });
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="0"] img'), "quote target PDF", 60_000);
	await waitFor(async () => (await page.$eval(".gui-pdf-page-input", element => element.value).catch(() => "")) === String(quote.pdf.startPage), "quote page restoration");
	assert("clicking a PDF quote restores its page", true);
	assert("quote restoration does not require a text-search fallback", !(await page.$(".gui-pdf-restore-notice")));

	// At 50% zoom the first page and the text at the top of page two are both
	// visible. Drag real pointer input across their boundary; never synthesize
	// the anchor that this assertion is meant to verify.
	for (let attempt = 0; attempt < 5; attempt++) {
		const value = await page.$eval(".gui-pdf-zoom-value", element => Number.parseInt(element.textContent ?? "100", 10));
		if (value <= 50) break;
		await page.click('button[aria-label="缩小"], button[aria-label="Zoom out"]');
		await waitFor(async () => (await page.$eval(".gui-pdf-zoom-value", element => Number.parseInt(element.textContent ?? "100", 10))) < value, "PDF zoom out for cross-page selection");
	}
	await page.evaluate(() => document.querySelector(".gui-pdf-viewport")?.scrollTo({ top: 0, behavior: "instant" }));
	await sleep(800);
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="0"] img'), "cross-page selection first page", 60_000);
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="1"] img'), "cross-page selection second page", 60_000);
	const findTextPoint = async (pageIndex, candidates) => {
		const box = await (await page.$(`.gui-pdf-page[data-pdf-page="${pageIndex}"]`))?.boundingBox();
		if (!box) throw new Error(`PDF page ${pageIndex + 1} has no pointer bounds`);
		for (const [x, y] of candidates) {
			await page.mouse.move(box.x + x, box.y + y);
			await sleep(40);
			const cursor = await page.$eval(`.gui-pdf-page[data-pdf-page="${pageIndex}"] > div`, element => element.style.cursor);
			if (cursor === "text") return { x: box.x + x, y: box.y + y };
		}
		throw new Error(`Could not locate a text glyph on PDF page ${pageIndex + 1}`);
	};
	const crossStart = await findTextPoint(0, [[100, 50], [150, 50], [60, 120], [100, 85]]);
	const crossEnd = await findTextPoint(1, [[180, 100], [150, 50], [100, 85], [80, 120]]);
	await page.mouse.move(crossStart.x, crossStart.y);
	await page.mouse.down();
	await page.mouse.move(crossEnd.x, crossEnd.y, { steps: 20 });
	await page.mouse.up();
	await waitFor(() => page.$(".gui-select-pop"), "cross-page PDF selection toolbar", 15_000);
	await page.click(".gui-select-pop-btn");
	const crossPageQuote = await waitFor(
		() => page.evaluate(() => {
			const value = window.__lastPdfQuote;
			return value?.kind === "file-quote" && value.pdf?.endPage > value.pdf?.startPage ? value : null;
		}),
		"structured cross-page PDF quote",
		30_000,
	);
	report.crossPageQuote = crossPageQuote;
	const selectedPages = new Set(crossPageQuote.pdf.selections.map(selection => selection.pageIndex));
	assert(
		"cross-page PDF quote retains anchors on both pages",
		crossPageQuote.pdf.startPage === 1 && crossPageQuote.pdf.endPage === 2 && selectedPages.has(0) && selectedPages.has(1),
		crossPageQuote.pdf,
	);
	assert("cross-page PDF quote contains selected text", crossPageQuote.quote.trim().length > 0);

	await page.evaluate(() => {
		window.dispatchEvent(new CustomEvent("musepi-gui-quote-append", {
			detail: { displayContext: { kind: "chat-quote", quote: "Separate chat source" } },
		}));
	});
	await waitFor(async () => (await page.$$(".gui-quote-chip")).length === 2, "file and chat reference chips");
	assert("mixed references stay collapsed without inline detail cards", !(await page.$(".gui-quote-card")));
	assert(
		"two PDF quotes and one chat quote collapse into two source chips",
		await page.evaluate(() => {
			const counts = [...document.querySelectorAll(".gui-quote-chip-count")].map(element => element.textContent);
			return counts.includes("2") && counts.includes("1");
		}),
	);
	await page.click('[data-quote-kind="file-quote"]');
	await waitFor(async () => (await page.$$(".gui-quote-card")).length === 2, "two PDF entries in the file reference popup");
	const crossPageLabel = await page.$$eval(
		".gui-quote-context-page",
		(elements, expected) => elements.map(element => element.textContent ?? "").find(text => text.includes(expected)),
		`PDF ${crossPageQuote.pdf.startPage}-${crossPageQuote.pdf.endPage}`,
	);
	assert("file reference popup lists both PDF selections with their page ranges", Boolean(crossPageLabel), crossPageLabel);
	await page.keyboard.press("Escape");

	await openFile(pdfPath, { pdf: crossPageQuote.pdf, quote: crossPageQuote.quote });
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="0"] img'), "cross-page quote target PDF", 60_000);
	await waitFor(async () => (await page.$eval(".gui-pdf-page-input", element => element.value).catch(() => "")) === String(crossPageQuote.pdf.startPage), "cross-page quote page restoration");
	assert("clicking a cross-page PDF quote restores its starting page", true);
	assert("cross-page quote restoration does not require a text-search fallback", !(await page.$(".gui-pdf-restore-notice")));

	await page.evaluate(() => {
		const button = [...document.querySelectorAll(".gui-pdf-toolbar button")].find(element => ["页面缩略图", "Page thumbnails"].includes(element.getAttribute("title") ?? ""));
		button?.click();
	});
	await waitFor(() => page.$(".gui-pdf-thumbnails img"), "PDF thumbnails", 30_000);
	assert("thumbnail pane renders page images", (await page.$$(".gui-pdf-thumbnails img")).length > 0);
	await page.screenshot({ path: screenshotPath });
	report.screenshot = screenshotPath;

	const openWithButton = await waitFor(async () => page.evaluate(() => {
		const button = [...document.querySelectorAll(".gui-filepane-preview-tools button")].find(element => ["打开方式…", "Open with…"].includes(element.getAttribute("title") ?? ""));
		button?.click();
		return Boolean(button);
	}), "open-with button");
	assert("every file exposes the open-with picker", openWithButton);
	await waitFor(() => page.$(".gui-file-open-with .gui-view-opt"), "installed application list");
	assert("open-with lists installed applications", (await page.$$(".gui-file-open-with .gui-view-opt")).length > 0);
	await page.keyboard.press("Escape");

	const verifyFailure = async name => {
		const details = await waitFor(
			() => page.$eval(".gui-pdf-status--error", element => ({
				text: element.textContent?.trim() ?? "",
				actions: [...element.querySelectorAll(".gui-pdf-error-actions button")].map(button => button.textContent?.trim() ?? ""),
			})).catch(() => null),
			`${name} visible error`,
			45_000,
		);
		assert(`${name} shows a visible failure instead of waiting forever`, details.text.length > 0, details);
		assert(`${name} retains retry and external-open actions`, details.actions.length === 2, details);
		assert(`${name} does not render a partial reader`, !(await page.$(".gui-pdf-reader")));
		return details;
	};

	await openFile(corruptPath);
	report.corruptFailure = await verifyFailure("corrupt PDF");
	const workersBeforeRetry = pdfWorkers.length;
	await page.click(".gui-pdf-error-actions button");
	await waitFor(() => pdfWorkers.length > workersBeforeRetry, "fresh PDFium Worker after corrupt-PDF retry", 45_000);
	report.corruptRetry = await verifyFailure("corrupt PDF retry");

	await openFile(encryptedPath);
	report.encryptedFailure = await verifyFailure("encrypted PDF");

	await openFile(pdfPath);
	await waitFor(() => page.$('.gui-pdf-page[data-pdf-page="0"] img'), "valid PDF after encrypted-document failure", 60_000);
	assert("a valid PDF opens after an encrypted-document failure", true);

	await openFile(otherPath);
	await waitFor(async () => !(await page.$(".gui-pdf-reader")), "PDF reader close");
	const createdWorkers = pdfWorkers.filter(worker => !workerBaseline.has(worker));
	report.closedWorkerStats = await waitFor(async () => {
		const closed = createdWorkers.filter(worker => destroyedPdfWorkers.has(worker)).length;
		return createdWorkers.length > 0 && closed === createdWorkers.length ? { created: createdWorkers.length, closed } : null;
	}, "PDFium Worker termination");
	assert("closing the PDF terminates its Workers", true, report.closedWorkerStats);
	assert("PDF verification has no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	report.error = error instanceof Error ? error.stack : String(error);
	report.electronOutput = electronOutput;
	report.electronExitCode = electron?.exitCode ?? null;
	if (browser) {
		const pages = await browser.pages();
		const page = pages.find(candidate => candidate.url().includes("dist/index.html"));
		if (page) {
			report.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 8_000);
			report.domSummary = await page.evaluate(() => ({
				pdfPages: document.querySelectorAll(".gui-pdf-page").length,
				pdfImages: document.querySelectorAll(".gui-pdf-page img").length,
				previewBodyHtml: document.querySelector(".gui-filepane-preview-body")?.innerHTML.slice(0, 8_000),
				previewBodyText: document.querySelector(".gui-filepane-preview-body")?.textContent,
				selectionHtml: document.querySelector('.gui-pdf-page[data-pdf-page="0"]')?.innerHTML.slice(0, 4_000),
				pointerEvents: window.__pdfPointerEvents ?? [],
				toolbar: (() => {
					const element = document.querySelector(".gui-pdf-toolbar");
					return element ? { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, height: element.getBoundingClientRect().height } : null;
				})(),
				resources: performance.getEntriesByType("resource").map(entry => entry.name).filter(name => name.includes("embedpdf") || name.includes("pdf")),
			}));
			await page.screenshot({ path: screenshotPath }).catch(() => {});
		}
	}
	const mainLog = path.join(fixture, ".musepi", "logs", `gui-main.${new Date().toISOString().slice(0, 10)}.log`);
	if (fs.existsSync(mainLog)) report.mainLog = fs.readFileSync(mainLog, "utf8").slice(-8_000);
	console.error(JSON.stringify(report, null, 2));
	process.exitCode = 1;
} finally {
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
	if (browser) browser.disconnect();
	if (typeof daemonPort === "number") await daemonRequest(daemonPort, "system.shutdown", {}).catch(() => {});
	if (electron && electron.exitCode === null) {
		electron.kill();
		await Promise.race([new Promise(resolve => electron.once("exit", resolve)), sleep(5_000)]);
	}
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			fs.rmSync(fixture, { recursive: true, force: true });
			break;
		} catch {
			await sleep(100);
		}
	}
	process.exit(process.exitCode ?? 0);
}
