#!/usr/bin/env node
/** Real Electron Office verification. Run through scripts/dev-smoke.ts.
 * All fixtures are synthetic and live only in the ignored .tmp directory. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import puppeteer from "puppeteer-core";
import * as XLSX from "xlsx";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixture = path.join(repoRoot, ".tmp", `office-workspace-e2e-${process.pid}`);
const wordPath = path.join(fixture, "sample.docx");
const workbookPath = path.join(fixture, "sample.xlsx");
const presentationPath = path.join(fixture, "sample.pptx");
const reportPath = path.join(repoRoot, ".tmp", "office-workspace-e2e-report.json");
const report = { assertions: [], runtimeErrors: [], console: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(name, value, details) {
	report.assertions.push({ name, pass: Boolean(value), ...(details === undefined ? {} : { details }) });
	if (!value) throw new Error(`Assertion failed: ${name}${details ? ` — ${JSON.stringify(details)}` : ""}`);
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

async function waitFor(fn, description, timeoutMs = 25_000) {
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

function presentationBytes() {
	const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="7" name="Title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="8000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Old title</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
	return zipSync({
		"ppt/presentation.xml": strToU8(
			`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
		),
		"ppt/slides/slide1.xml": strToU8(slide),
	});
}

fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "office-workspace-e2e", private: true }));
const wordDocument = new Document({
	sections: [{ children: [new Paragraph({ children: [new TextRun("Before")] }), new Paragraph({ children: [new TextRun("Keep this")] })] }],
});
fs.writeFileSync(wordPath, await Packer.toBuffer(wordDocument));
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Value"], ["Alpha", 42]]), "Data");
fs.writeFileSync(workbookPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
fs.writeFileSync(presentationPath, presentationBytes());

let electron;
let browser;
let daemonPort;
let electronOutput = "";
let createdSessionId;
const openWithCapturePath = path.join(fixture, "open-with.jsonl");
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
			"      - id: fake-office-workspace",
			"        name: Fake Office Workspace",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	const isolatedEnv = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
		HOME: fixture,
		USERPROFILE: fixture,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: path.join(fixture, "config"),
		MUSEPI_VERSION: appVersion,
		MUSEPI_GUI_USER_DATA: path.join(fixture, "electron-data"),
		MUSEPI_CDP_PORT: String(cdpPort),
		MUSEPI_GUI_DAEMON_PORT: String(daemonPort),
		MUSEPI_TEST_OPEN_WITH_CAPTURE: openWithCapturePath,
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
	await page.evaluateOnNewDocument(`//!world=main
		window.__officeMainErrors = [];
		const originalError = console.error;
		console.error = (...args) => {
			window.__officeMainErrors.push(args.map(value => value instanceof Error ? value.stack : String(value)).join(" "));
			originalError(...args);
		};
	`);
	page.on("pageerror", error => report.runtimeErrors.push(error.message));
	page.on("console", message => {
		report.console.push({ type: message.type(), text: message.text() });
		if (message.type() === "error" && !message.text().includes("ERR_CONNECTION_REFUSED")) {
			report.runtimeErrors.push(message.text());
		}
	});
	try {
		await waitFor(() => page.$(".gui-header"), "GUI header", 35_000);
	} catch {
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(() => page.$(".gui-header"), "GUI header after startup reload", 35_000);
	}
	await page.evaluate(() => localStorage.setItem("musepi-gui-onboarding-done", "1"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitFor(() => page.$(".gui-header"), "GUI header after onboarding setup");
	await sleep(800);
	if (!(await page.$(".gui-session-row"))) {
		const created = await daemonRequest(daemonPort, "session.create", {
			cwd: fixture,
			autoTitle: false,
			modelPattern: "fake/fake-office-workspace",
		});
		createdSessionId = created?.sessionId;
		await waitFor(() => page.$(".gui-session-row"), "created session row");
		await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
		await waitFor(() => page.$(".gui-transcript"), "selected session");
	}
	const bridge = await page.evaluate(`//!world=main
		({ url: location.href, electronAPI: typeof window.electronAPI, openWith: typeof window.electronAPI?.openWith })
	`);
	assert("real Electron preload exposes the Office open-with bridge", bridge.electronAPI === "object" && bridge.openWith === "function", bridge);
	const openFile = async filePath => {
		await page.evaluate(target => {
			window.dispatchEvent(new CustomEvent("musepi-open-file", { detail: { path: target, pin: true } }));
		}, filePath);
	};
	const activeName = () => page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
	const activateTab = async name => {
		await page.evaluate(target => {
			const tab = [...document.querySelectorAll(".gui-surface-tab")].find(element => element.textContent?.includes(target));
			tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		}, name);
	};
	const selectAndQuote = async selector => {
		await page.evaluate(target => {
			const element = document.querySelector(target);
			if (!element) throw new Error(`Missing quote target: ${target}`);
			const range = document.createRange();
			range.selectNodeContents(element);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		}, selector);
		await waitFor(() => page.$(".gui-select-pop"), `selection toolbar for ${selector}`);
		await page.evaluate(() => document.querySelector(".gui-select-pop-btn")?.click());
		await waitFor(() => page.$('.gui-quote-chip[data-quote-kind="file-quote"]'), "composer file quote chip");
	};

	await openFile(wordPath);
	await waitFor(async () => (await activeName()) === "sample.docx" && Boolean(await page.$('[data-office-kind="word"]')), "Word renderer");
	assert("Word renders editable paragraphs", await page.$$eval('[data-office-kind="word"]', nodes => nodes.length === 2));
	await page.focus('[data-office-kind="word"][data-paragraph-id="0"]');
	await page.evaluate(() => {
		const paragraph = document.querySelector('[data-office-kind="word"][data-paragraph-id="0"]');
		paragraph.innerText = "After CtrlS";
		paragraph.dispatchEvent(new InputEvent("input", { bubbles: true }));
	});
	await page.keyboard.down("Control");
	await page.keyboard.press("s");
	await page.keyboard.up("Control");
	await waitFor(async () => {
		const files = unzipSync(fs.readFileSync(wordPath));
		return strFromU8(files["word/document.xml"]).includes("After CtrlS");
	}, "Word Ctrl+S disk write");
	assert("Word Ctrl+S saves the latest edit to disk", true);
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "Word clean after save");

	await page.evaluate(() => {
		const paragraph = document.querySelector('[data-office-kind="word"][data-paragraph-id="0"]');
		paragraph.innerText = "Draft Remount";
		paragraph.dispatchEvent(new InputEvent("input", { bubbles: true }));
	});
	await waitFor(() => page.$(".gui-surface-tab--active .gui-surface-tab-dirty"), "Word dirty tab");
	await openFile(workbookPath);
	await waitFor(async () => (await activeName()) === "sample.xlsx" && Boolean(await page.$('[data-office-kind="workbook"]')), "Excel renderer");
	assert("Excel renders sheet and cells", Boolean(await page.$('[data-sheet="Data"][data-cell="B2"]')));
	await activateTab("sample.docx");
	await waitFor(async () => (await activeName()) === "sample.docx" && Boolean(await page.$('[data-office-kind="word"]')), "return to Word");
	assert(
		"Word draft survives tab unmount and remount",
		await page.$eval('[data-office-kind="word"][data-paragraph-id="0"]', element => element.innerText === "Draft Remount"),
	);
	await page.evaluate(() => {
		const tab = [...document.querySelectorAll(".gui-surface-tab")].find(element => element.textContent?.includes("sample.docx"));
		tab?.querySelector(".gui-surface-tab-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(() => page.$(".gui-dialog-backdrop, [role='dialog']"), "dirty Office close confirmation");
	await page.evaluate(() => {
		const buttons = [...document.querySelectorAll(".gui-dialog-backdrop button, [role='dialog'] button")];
		buttons.find(button => /仍然关闭|discard|close/i.test(button.textContent ?? "") && !/取消|cancel/i.test(button.textContent ?? ""))?.click();
	});
	await waitFor(async () => !(await page.$$eval(".gui-surface-tab", tabs => tabs.some(tab => tab.textContent?.includes("sample.docx")))), "confirmed Office close");
	assert("dirty Office tab asks before closing and can be discarded", true);

	await activateTab("sample.xlsx");
	await waitFor(() => page.$('[data-sheet="Data"][data-cell="B2"]'), "Excel active cell");
	await page.evaluate(() => {
		const cell = document.querySelector('[data-sheet="Data"][data-cell="B2"]');
		cell.innerText = "84";
		cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
	});
	await waitFor(() => page.$(".gui-filepane-preview-tools button[aria-label='保存']:not([disabled])"), "enabled Excel header save");
	await page.evaluate(() => document.querySelector(".gui-filepane-preview-tools button[aria-label='保存']")?.click());
	await waitFor(async () => {
		const saved = XLSX.read(fs.readFileSync(workbookPath), { type: "buffer" });
		return saved.Sheets.Data?.B2?.v === "84";
	}, "Excel header save disk write");
	assert("Excel header save writes the edited cell", true);
	await selectAndQuote('[data-sheet="Data"][data-cell="A2"]');

	await openFile(presentationPath);
	await waitFor(async () => (await activeName()) === "sample.pptx" && Boolean(await page.$('[data-office-kind="presentation"]')), "PowerPoint renderer");
	assert(
		"PowerPoint renders stable slide and shape anchors",
		Boolean(await page.$('[data-office-kind="presentation"][data-slide="1"][data-shape-id="7"]')),
	);
	await selectAndQuote('[data-office-kind="presentation"][data-shape-id="7"]');
	await page.evaluate(() => document.querySelector(".gui-filepane-preview-tools button[title='用默认应用打开']")?.click());
	await page.evaluate(() => document.querySelector(".gui-filepane-preview-tools button[aria-label='打开方式…']")?.click());
	await waitFor(() => page.$(".gui-file-open-with"), "open-with menu");
	await page.evaluate(() => {
		const button = [...document.querySelectorAll(".gui-file-open-with button")].find(item => item.textContent?.includes("Test Editor"));
		button?.click();
	});
	const openCalls = await waitFor(() => {
		if (!fs.existsSync(openWithCapturePath)) return null;
		const calls = fs.readFileSync(openWithCapturePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		return calls.length === 2 ? calls : null;
	}, "main-process open-with capture");
	assert(
		"default app and open-with use the current file without launching a real app",
		openCalls[0]?.app === "" && openCalls[0]?.path === presentationPath && openCalls[1]?.app === "Test Editor" && openCalls[1]?.path === presentationPath,
		openCalls,
	);

	await openFile(wordPath);
	await waitFor(() => page.$('[data-office-kind="word"][data-paragraph-id="1"]'), "fresh Word for quote");
	await selectAndQuote('[data-office-kind="word"][data-paragraph-id="1"]');
	const quoteChipText = await page.$eval('.gui-quote-chip[data-quote-kind="file-quote"]', element => element.textContent);
	assert("three Office selections share the existing aggregated quote toolbar", quoteChipText?.includes("3"), quoteChipText);

	const created = createdSessionId ? null : await daemonRequest(daemonPort, "session.list", {});
	const resolvedSessionId = createdSessionId ?? created?.sessions?.find(item => item.cwd === fixture)?.sessionId ?? created?.sessions?.[0]?.sessionId;
	assert("real session available for historical Office quotes", typeof resolvedSessionId === "string", { createdSessionId, created });
	await daemonRequest(daemonPort, "session.send", {
		sessionId: resolvedSessionId,
		text: "Review the Office references.",
		displayContext: [
			{ kind: "file-quote", path: "sample.docx", quote: "Keep this", language: "docx", office: { kind: "word", paragraphId: 1 } },
			{ kind: "file-quote", path: "sample.xlsx", quote: "Alpha", language: "xlsx", office: { kind: "workbook", sheet: "Data", startCell: "A2", endCell: "A2" } },
			{ kind: "file-quote", path: "sample.pptx", quote: "Old title", language: "pptx", office: { kind: "presentation", slide: 1, shapeId: "7" } },
		],
	});
	await waitFor(async () => (await page.$$eval(".tr-display-context-source", nodes => nodes.length)) >= 3, "persisted historical Office quote cards", 35_000);
	const clickHistory = async name => {
		await page.evaluate(target => {
			const source = [...document.querySelectorAll(".tr-display-context-source")].find(node => node.textContent?.includes(target));
			source?.click();
		}, name);
	};
	await clickHistory("sample.docx");
	await waitFor(async () => (await activeName()) === "sample.docx", "historical Word quote opens file");
	assert(
		"historical Word quote restores paragraph and selection",
		await page.evaluate(() => window.getSelection()?.toString() === "Keep this" && window.getSelection()?.anchorNode?.parentElement?.closest("[data-paragraph-id]")?.getAttribute("data-paragraph-id") === "1"),
	);
	await clickHistory("sample.xlsx");
	await waitFor(async () => (await activeName()) === "sample.xlsx", "historical Excel quote opens file");
	assert(
		"historical Excel quote restores sheet cell and selection",
		await page.evaluate(() => window.getSelection()?.toString() === "Alpha" && window.getSelection()?.anchorNode?.parentElement?.closest("[data-cell]")?.getAttribute("data-cell") === "A2"),
	);
	await clickHistory("sample.pptx");
	await waitFor(async () => (await activeName()) === "sample.pptx", "historical PowerPoint quote opens file");
	assert(
		"historical PowerPoint quote restores slide shape and selection",
		await page.evaluate(() => window.getSelection()?.toString() === "Old title" && window.getSelection()?.anchorNode?.parentElement?.closest("[data-shape-id]")?.getAttribute("data-shape-id") === "7"),
	);
	assert("Office lifecycle produced no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
	report.electronOutput = electronOutput;
	if (browser) {
		const pages = await browser.pages();
		const page = pages.find(candidate => candidate.url().includes("dist/index.html"));
		if (page) {
			report.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 8_000);
			report.mainWorldErrors = await page.evaluate(`//!world=main
				window.__officeMainErrors ?? []
			`);
		}
	}
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
}
