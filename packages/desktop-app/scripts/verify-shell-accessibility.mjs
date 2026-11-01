#!/usr/bin/env node
/** Real Electron checks for the narrow sidebar drawer and command-palette focus.
 * Run through scripts/dev-smoke.ts so agent and daemon state stay isolated. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixture = path.join(repoRoot, ".tmp", `shell-accessibility-e2e-${process.pid}`);
const reportPath = path.join(repoRoot, ".tmp", "shell-accessibility-e2e-report.json");
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
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "shell-accessibility-e2e", private: true }));

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
			"      - id: fake-shell-accessibility",
			"        name: Fake Shell Accessibility",
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
	await waitFor(() => page.$(".gui-sidebar-toggle"), "sidebar toggle after onboarding setup");
	await page.setViewport({ width: 640, height: 800, deviceScaleFactor: 1 });
	await waitFor(() => page.evaluate(() => matchMedia("(max-width: 720px)").matches), "narrow media query");
	await waitFor(
		() => page.$eval(".gui-side-keeper", element => getComputedStyle(element).visibility === "hidden"),
		"closed narrow drawer styles",
		5_000,
	);

	const chatBefore = await page.$eval(".gui-chat-col", element => {
		const rect = element.getBoundingClientRect();
		return { x: rect.x, width: rect.width };
	});
	const closedSidebar = await page.$eval(".gui-side-keeper", element => {
		const style = getComputedStyle(element);
		return {
			position: style.position,
			visibility: style.visibility,
			display: style.display,
			transform: style.transform,
			drawerOpen: element.classList.contains("gui-side-keeper--drawer-open"),
			viewport: innerWidth,
			narrowMedia: matchMedia("(max-width: 720px)").matches,
		};
	});
	assert(
		"closed narrow sidebar stays outside the layout and is invisible",
		closedSidebar.position === "absolute" && closedSidebar.visibility === "hidden" && !closedSidebar.drawerOpen,
		closedSidebar,
	);
	await page.click(".gui-sidebar-toggle");
	await waitFor(
		() => page.$eval(".gui-side-keeper--drawer-open", element => getComputedStyle(element).visibility === "visible"),
		"open narrow drawer styles",
		5_000,
	);
	assert(
		"open narrow drawer exposes the mounted sidebar and modal backdrop",
		await page.evaluate(() => {
			const sidebar = document.querySelector(".gui-side-keeper");
			const backdrop = document.querySelector(".gui-sidebar-drawer-backdrop");
			return Boolean(sidebar && backdrop && getComputedStyle(sidebar).visibility === "visible");
		}),
	);
	const chatAfter = await page.$eval(".gui-chat-col", element => {
		const rect = element.getBoundingClientRect();
		return { x: rect.x, width: rect.width };
	});
	assert("drawer does not resize or shift the chat column", JSON.stringify(chatAfter) === JSON.stringify(chatBefore), {
		before: chatBefore,
		after: chatAfter,
	});
	await page.screenshot({ path: path.join(repoRoot, ".tmp", "shell-narrow-drawer.png") });
	await page.mouse.click(600, 400);
	await waitFor(async () => !(await page.$(".gui-side-keeper--drawer-open")), "backdrop closes narrow drawer");

	await page.focus(".gui-sidebar-toggle");
	await page.keyboard.down("Control");
	await page.keyboard.press("k");
	await page.keyboard.up("Control");
	await waitFor(() => page.$(".gui-palette input[role='combobox']"), "command palette combobox");
	assert(
		"command palette initially links the combobox to an active option",
		await page.$eval(".gui-palette input", input => {
			const id = input.getAttribute("aria-activedescendant");
			return Boolean(id && document.getElementById(id)?.getAttribute("role") === "option");
		}),
	);
	const activeBefore = await page.$eval(".gui-palette input", input => input.getAttribute("aria-activedescendant"));
	await page.keyboard.press("ArrowDown");
	const activeAfter = await page.$eval(".gui-palette input", input => input.getAttribute("aria-activedescendant"));
	assert("ArrowDown moves the active command option", activeBefore !== activeAfter, { before: activeBefore, after: activeAfter });
	const focusBeforeTab = await page.evaluate(() => ({
		tag: document.activeElement?.tagName,
		className: document.activeElement?.className,
		inside: Boolean(document.querySelector(".gui-palette")?.contains(document.activeElement)),
	}));
	await page.keyboard.press("Tab");
	await sleep(100);
	const focusAfterTab = await page.evaluate(() => ({
		tag: document.activeElement?.tagName,
		className: document.activeElement?.className,
		inside: Boolean(document.querySelector(".gui-palette")?.contains(document.activeElement)),
	}));
	assert("Tab keeps focus inside the command dialog", focusAfterTab.inside, { before: focusBeforeTab, after: focusAfterTab });
	await page.screenshot({ path: path.join(repoRoot, ".tmp", "shell-command-palette.png") });
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".gui-palette")), "command palette closes");
	assert(
		"Escape restores focus to the command opener",
		await page.evaluate(() => document.activeElement?.classList.contains("gui-sidebar-toggle")),
	);
	assert("shell accessibility checks produced no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
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
