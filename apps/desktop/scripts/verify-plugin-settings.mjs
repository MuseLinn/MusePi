#!/usr/bin/env node
/** Real Electron verification for manifest-backed plugin configuration.
 * Run through scripts/dev-smoke.ts so daemon and settings state stay isolated. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer-core";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixture = path.join(repoRoot, ".tmp", `plugin-settings-e2e-${process.pid}`);
const reportPath = path.join(repoRoot, ".tmp", "plugin-settings-e2e-report.json");
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
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "plugin-settings-e2e", private: true }));
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
			"      - id: fake-plugin-settings",
			"        name: Fake Plugin Settings",
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
	const registry = () => daemonRequest(daemonPort, "extensions.list", {});
	const computer = async () => (await registry()).extensions.find(item => item.id === "computer");
	const openPluginRows = async () => {
		let registryReady = false;
		for (let attempt = 0; attempt < 4 && !registryReady; attempt++) {
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitFor(() => page.$(".gui-header"), "GUI header before plugin registry");
			await page.evaluate(() => window.dispatchEvent(new CustomEvent("musepi-gui-open-settings-section", { detail: "skills" })));
			await sleep(800);
			const configurable = (await registry()).extensions.find(item => item.config?.length);
			if (configurable) {
				const field = configurable.config[0];
				await daemonRequest(daemonPort, "extensions.setConfig", {
					id: configurable.id,
					key: field.key,
					value:
						field.type === "string" || field.type === "path"
							? `__registry_refresh_${attempt}__`
							: configurable.configValues?.[field.key] ?? field.default,
				});
			}
			registryReady = await waitFor(
				() =>
					page.evaluate(() =>
						[...document.querySelectorAll(".gui-ext-tab-count")].some(element => Number(element.textContent) > 0),
					),
				"extension registry counters",
				8_000,
			).catch(() => false);
		}
		if (!registryReady) throw new Error("Extension registry remained empty after four renderer reloads");
		if (!(await page.$(".gui-plugin-card"))) {
			await page.evaluate(() => {
				const tab = [...document.querySelectorAll('button[role="tab"]')].find(button =>
					/^(?:插件|Plugins)\s*\d+$/.test(button.textContent?.trim() ?? ""),
				);
				tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
		}
		await waitFor(() => page.$(".gui-plugin-card"), "plugin rows");
	};
	if (process.env.CURATED_ICONS_ONLY) {
		await page.evaluate(() => {
			const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === "能力中心");
			button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await waitFor(
			() =>
				page.evaluate(() => {
					const tab = [...document.querySelectorAll('button[role="tab"]')].find(button =>
						/插件市场|Marketplace/.test(button.textContent ?? ""),
					);
					return tab ?? null;
				}),
			"marketplace tab",
		);
		await page.evaluate(() => {
			const tab = [...document.querySelectorAll('button[role="tab"]')].find(button => /插件市场|Marketplace/.test(button.textContent ?? ""));
			tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await waitFor(() => page.$(".mp-card"), "curated marketplace cards");
		await waitFor(
			() =>
				page.evaluate(() => {
					const images = [...document.querySelectorAll(".mp-card-artwork")];
					return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
				}),
			"curated marketplace artwork decoded",
			35_000,
		);
		const sources = await page.evaluate(() =>
			[...document.querySelectorAll(".mp-card-artwork")].map(image => image.src).sort(),
		);
		assert("Curated marketplace cards render both upstream logos", sources.every(source => /app-icon.png|logo.png/.test(source)), sources);
		await page.screenshot({ path: path.join(repoRoot, ".tmp", "curated-marketplace-icons.png") });
		assert("Curated marketplace artwork produced no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
		console.log(JSON.stringify(report, null, 2));
	}
	if (!process.env.CURATED_ICONS_ONLY) {
	if (!process.env.SUBAGENT_ONLY) {
	const initial = await computer();
	assert(
		"computer plugin starts active with declarative configuration",
		initial?.state === "active" && initial.config?.length === 2,
		initial ?? (await registry()).extensions.map(item => ({ id: item.id, name: item.name, state: item.state })),
	);
	assert(
		"computer configuration does not invent a settings runtime slot",
		!(await registry()).components.some(item => item.extensionId === initial.id && item.slot?.startsWith("settings.")),
	);

	await openPluginRows();
	const openComputer = () =>
		page.evaluate(() => {
			const row = [...document.querySelectorAll(".gui-plugin-card")].find(item => item.textContent?.includes("电脑控制"));
			row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	await openComputer();
	await waitFor(() => page.$('.gui-plugin-dialog input[aria-label="computer.display"]'), "computer plugin configuration");

	await page.click('.gui-plugin-dialog input[aria-label="computer.display"]');
	await page.keyboard.down("Control");
	await page.keyboard.press("a");
	await page.keyboard.up("Control");
	await page.keyboard.type("display-e2e");
	await waitFor(async () => (await computer())?.configValues?.["computer.display"] === "display-e2e", "string config RPC persistence");
	assert("string field writes through the real GUI and daemon", true);

	await page.evaluate(() => {
		const input = document.querySelector('.gui-plugin-dialog input[aria-label="computer.maxWidth"]');
		const row = input?.closest(".gui-settings-row");
		const buttons = row?.querySelectorAll(".gui-stepper-btn");
		buttons?.[buttons.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(async () => (await computer())?.configValues?.["computer.maxWidth"] === 3841, "number config RPC persistence");
	await waitFor(() => page.$(".gui-plugin-config-notice"), "configuration saved notice");
	assert("number stepper writes a numeric value and shows saved feedback", true);

	await page.evaluate(() => document.querySelector(".gui-plugin-dialog .gui-dialog-head [role='switch']")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await waitFor(async () => (await computer())?.state !== "active", "disable from plugin detail");
	await waitFor(
		() => page.$(".gui-plugin-dialog .gui-dialog-head [role='switch'][aria-checked='false']:not([disabled])"),
		"disabled state rendered in plugin detail",
	);
	assert("plugin detail switch disables the real package", true);
	assert(
		"declarative values remain available while the package is disabled",
		(await page.$eval('.gui-plugin-dialog input[aria-label="computer.display"]', input => input.value)) === "display-e2e" &&
			(await page.$eval('.gui-plugin-dialog input[aria-label="computer.maxWidth"]', input => input.value)) === "3841",
	);
	await page.evaluate(() => document.querySelector(".gui-plugin-dialog .gui-dialog-head [role='switch']")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await waitFor(async () => (await computer())?.state === "active", "re-enable from plugin detail");
	assert("plugin detail switch re-enables the same package", true);

	await page.evaluate(() => document.querySelector(".gui-plugin-dialog .gui-dialog-head button.gui-tool-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await waitFor(async () => !(await page.$(".gui-plugin-dialog")), "close plugin details");
	await openComputer();
	await waitFor(() => page.$('.gui-plugin-dialog input[aria-label="computer.display"]'), "reopen computer plugin configuration");
	assert(
		"reopening details restores both persisted values",
		(await page.$eval('.gui-plugin-dialog input[aria-label="computer.display"]', input => input.value)) === "display-e2e" &&
			(await page.$eval('.gui-plugin-dialog input[aria-label="computer.maxWidth"]', input => input.value)) === "3841",
	);

	}

	await page.evaluate(() => document.querySelector(".gui-plugin-dialog .gui-dialog-head button.gui-tool-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await waitFor(async () => !(await page.$(".gui-plugin-dialog")), "close computer details before external subagent");
	const subagent = (await registry()).extensions.find(item => item.name === "subagent-codex");
	assert("Codex subagent exposes executable and environment configuration", subagent?.state === "active" && subagent.config?.some(field => field.key === "executable") && subagent.config?.some(field => field.key === "env"));
	await openPluginRows();
	await page.evaluate(() => {
		const row = [...document.querySelectorAll(".gui-plugin-card")].find(item => item.textContent?.includes("Codex"));
		row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(() => page.$('.gui-plugin-dialog input[name="executable"]'), "Codex executable configuration");
	await waitFor(
		() =>
			page.evaluate(() => {
				const text = document.querySelector(".gui-plugin-config-feedback")?.textContent?.trim();
				return text && !/检测中|Checking|extension not active/.test(text) ? text : null;
			}),
		"automatic executable probe feedback",
	);
	assert("opening external subagent details runs an executable probe", true);
	await page.click('.gui-plugin-dialog input[name="executable"]');
	await page.keyboard.down("Control");
	await page.keyboard.press("a");
	await page.keyboard.up("Control");
	await page.keyboard.type(process.execPath);
	await page.evaluate(() => document.querySelector('.gui-plugin-dialog input[name="executable"]')?.blur());
	await waitFor(
		() =>
			page.evaluate(
				version => document.querySelector(".gui-plugin-config-feedback")?.textContent?.includes(version),
				Bun.version,
			),
		"manual executable version",
	);
	assert(
		"manual executable probe shows version and resolved path",
		(await page.$eval(".gui-plugin-config-feedback", element => element.textContent)).includes(process.execPath),
	);
	await page.click('.gui-plugin-dialog input[name="env"]');
	await page.keyboard.type('{"TOKEN":1}');
	await page.evaluate(() => document.querySelector('.gui-plugin-dialog input[name="env"]')?.blur());
	await waitFor(
		() =>
			page.evaluate(() =>
				/值必须是字符串|Values must be strings/.test(
					document.querySelector('[id$="environment-feedback"]')?.textContent ?? "",
				),
			),
		"environment JSON error",
	);
	assert("environment JSON reports non-string values on blur", true);
	await page.click('.gui-plugin-dialog input[name="env"]');
	await page.keyboard.down("Control");
	await page.keyboard.press("a");
	await page.keyboard.up("Control");
	await page.keyboard.type('{"TOKEN":"ok"}');
	assert(
		"correcting environment JSON clears the old error immediately",
		!(await page.$('[id$="environment-feedback"]')),
	);
	await page.evaluate(() => document.querySelector('.gui-plugin-dialog input[name="env"]')?.blur());
	await waitFor(
		() =>
			page.evaluate(() =>
				/JSON 有效|Valid JSON/.test(document.querySelector('[id$="environment-feedback"]')?.textContent ?? ""),
			),
		"valid environment JSON",
	);
	assert("valid environment JSON has positive feedback", true);
	assert(
		"configuration controls do not overflow the dialog",
		await page.$eval(".gui-plugin-dialog", dialog => dialog.scrollWidth <= dialog.clientWidth + 1),
	);
	await page.screenshot({ path: path.join(repoRoot, ".tmp", "plugin-subagent-config.png") });

	if (!process.env.SUBAGENT_ONLY) {
	const voiceSchema = await daemonRequest(daemonPort, "settings.schema", {
		tabs: ["voice", "providers", "interaction"],
	});
	const isVoiceKey = key => /^(?:stt|tts|speech)\./.test(key) || key === "providers.tts" || key === "live.voice";
	const voiceKeys = new Set((voiceSchema.voice ?? []).map(item => item.key));
	const misplacedVoiceKeys = ["providers", "interaction"].flatMap(tab =>
		(voiceSchema[tab] ?? []).map(item => item.key).filter(isVoiceKey),
	);
	assert(
		"voice schema owns speech, provider, and Live Voice settings without duplicates",
		["stt.enabled", "tts.localModel", "tts.autoRead", "providers.tts", "live.voice"].every(key =>
			voiceKeys.has(key),
		) && misplacedVoiceKeys.length === 0,
		{ voiceKeys: [...voiceKeys], misplacedVoiceKeys },
	);

	// Keep STT disabled for the rest of this smoke: opening its picker must not
	// download an uncached model. TTS never auto-downloads and is safe to toggle.
	await daemonRequest(daemonPort, "extensions.setEnabled", { id: "stt", enabled: false });
	await waitFor(
		async () => (await registry()).extensions.find(item => item.id === "stt")?.state !== "active",
		"disable STT before opening voice settings",
	);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("musepi-gui-open-settings-section", { detail: "skills" })));
	await waitFor(() => page.$(".gui-settings-nav-col"), "settings navigation");
	await page.evaluate(() => {
		const item = [...document.querySelectorAll(".gui-settings-nav")].find(
			button => button.textContent?.includes("语音") || button.textContent?.includes("Voice"),
		);
		item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(() => page.$('input[name="tts-model"]'), "voice settings TTS model picker");
	assert(
		"voice page renders TTS while disabled STT shows its enable card",
		(await page.$$(".gui-settings-section--disabled")).length === 1 && !(await page.$('input[name="stt-model"]')),
	);

	await daemonRequest(daemonPort, "extensions.setEnabled", { id: "tts", enabled: false });
	await waitFor(
		async () => (await registry()).extensions.find(item => item.id === "tts")?.state !== "active",
		"disable TTS from daemon",
	);
	await waitFor(
		async () => (await page.$$(".gui-settings-section--disabled")).length === 2 && !(await page.$('input[name="tts-model"]')),
		"voice page removes disabled TTS controls",
	);
	assert("disabling TTS hides dependent controls without closing voice settings", true);

	await page.evaluate(() => {
		const cards = [...document.querySelectorAll(".gui-settings-section--disabled")];
		cards.at(-1)?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await waitFor(
		async () => (await registry()).extensions.find(item => item.id === "tts")?.state === "active",
		"re-enable TTS from voice settings",
	);
	await waitFor(() => page.$('input[name="tts-model"]'), "restored TTS model picker");
	assert(
		"voice page enable action restores TTS while STT stays disabled",
		(await page.$$(".gui-settings-section--disabled")).length === 1 && !(await page.$('input[name="stt-model"]')),
	);
	}
	}
	assert("plugin settings lifecycle produced no renderer runtime errors", report.runtimeErrors.length === 0, report.runtimeErrors);
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
