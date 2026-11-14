#!/usr/bin/env bun
/** Real Electron verification for the Cordis file-workspace lifecycle.
 * Run through scripts/dev-smoke.ts so sessions and daemon state stay isolated. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer-core";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixture = path.join(repoRoot, ".tmp", `file-workspace-e2e-${process.pid}`);
const firstPath = path.join(fixture, "first.txt");
const secondPath = path.join(fixture, "second.txt");
const reportPath = path.join(repoRoot, ".tmp", "file-workspace-e2e-report.json");
const report = { assertions: [], runtimeErrors: [] };
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

fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "file-workspace-e2e", private: true }));
fs.writeFileSync(firstPath, "first disk\n");
fs.writeFileSync(secondPath, "second disk\n");

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
			"      - id: fake-file-workspace",
			"        name: Fake File Workspace",
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
	page.on("pageerror", error => report.runtimeErrors.push(error.message));
	page.on("console", message => {
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
		await daemonRequest(daemonPort, "session.create", {
			cwd: fixture,
			autoTitle: false,
			modelPattern: "fake/fake-file-workspace",
		});
		await waitFor(() => page.$(".gui-session-row"), "created session row");
		await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
		await waitFor(() => page.$(".gui-transcript"), "selected session");
	}
	const openFile = async filePath => {
		await page.evaluate(target => {
			// Pinned instances keep both files open. Ordinary preview opens replace
			// one another by design, so they cannot exercise draft remounting.
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
	const editorText = () =>
		page
			.$eval(".monaco-editor .view-lines", element => (element.textContent ?? "").replace(/\u00a0/g, " "))
			.catch(() => "");

	const registry = await daemonRequest(daemonPort, "extensions.list", {});
	const fileExtension = registry.extensions.find(item => item.name.includes("file-workspace"));
	assert("file workspace appears as an active official plugin", fileExtension?.state === "active" && fileExtension?.builtin === true, fileExtension);
	assert(
		"file workspace contributes one compiled panel component",
		registry.components.filter(item => item.slot === "panel.tab.files" && item.code && !item.error).length === 1,
	);
	await openFile(firstPath);
	await waitFor(async () => (await activeName()) === "first.txt" && Boolean(await page.$(".monaco-editor")), "first Monaco editor");
	await openFile(secondPath);
	await waitFor(async () => (await activeName()) === "second.txt" && Boolean(await page.$(".monaco-editor")), "second Monaco editor");
	await activateTab("first.txt");
	await waitFor(async () => (await activeName()) === "first.txt" && Boolean(await page.$(".monaco-editor")), "return to first editor");
	await page.focus(".monaco-editor .native-edit-context");
	await page.keyboard.down("Control");
	await page.keyboard.press("End");
	await page.keyboard.up("Control");
	await page.keyboard.type("\nunsaved plugin draft");
	await waitFor(() => page.$(".gui-surface-tab--active .gui-surface-tab-dirty"), "dirty file tab");
	await activateTab("second.txt");
	await waitFor(async () => (await activeName()) === "second.txt", "switch away from dirty draft");
	await activateTab("first.txt");
	const restored = await waitFor(async () => ((await editorText()).includes("unsaved plugin draft") ? true : null), "host-owned draft restore");
	assert("dirty draft survives real plugin unmount and remount", restored);

	await page.evaluate(() => {
		const tab = [...document.querySelectorAll(".gui-surface-tab")].find(element => element.textContent?.includes("first.txt"));
		tab?.querySelector(".gui-surface-tab-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(() => page.$(".gui-dialog-backdrop, [role='dialog']"), "dirty close confirmation");
	await page.evaluate(() => {
		const buttons = [...document.querySelectorAll(".gui-dialog-backdrop button, [role='dialog'] button")];
		const confirm = buttons.find(button => /关闭|discard|close/i.test(button.textContent ?? "") && !/取消|cancel/i.test(button.textContent ?? ""));
		confirm?.click();
	});
	await waitFor(async () => !(await page.$$eval(".gui-surface-tab", tabs => tabs.some(tab => tab.textContent?.includes("first.txt")))), "confirmed dirty tab close");
	await openFile(firstPath);
	await waitFor(async () => (await activeName()) === "first.txt" && Boolean(await page.$(".monaco-editor")), "reopen discarded file");
	assert("confirmed close does not restore the discarded draft", !(await editorText()).includes("unsaved plugin draft"), await editorText());

	await daemonRequest(daemonPort, "extensions.setEnabled", { id: fileExtension.id, enabled: false });
	await waitFor(async () => !(await page.$(".gui-filepane")), "disabled plugin renderer unmount");
	assert("disabled plugin keeps the old tab closable", Boolean(await page.$(".gui-pane-tab-empty")));
	assert(
		"disabled plugin removes the file rail entry",
		await page.evaluate(() => ![...document.querySelectorAll(".gui-right-rail-btn")].some(button => button.getAttribute("aria-label") === "文件")),
	);
	const tabCountBeforeExternalOpen = await page.$$eval(".gui-surface-tab", tabs => tabs.length);
	await openFile(secondPath);
	await sleep(500);
	assert(
		"external open cannot bypass the disabled plugin",
		(await page.$$eval(".gui-surface-tab", tabs => tabs.length)) === tabCountBeforeExternalOpen && !(await page.$(".gui-filepane")),
	);
	await daemonRequest(daemonPort, "extensions.setEnabled", { id: fileExtension.id, enabled: true });
	await waitFor(() => page.$(".gui-filepane .monaco-editor"), "re-enabled plugin renderer");
	assert("re-enabling restores the existing file tab renderer", true);
	assert("file plugin lifecycle produced no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
	report.electronOutput = electronOutput;
	if (browser) {
		const pages = await browser.pages();
		const page = pages.find(candidate => candidate.url().includes("dist/index.html"));
		if (page) report.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 8_000);
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
