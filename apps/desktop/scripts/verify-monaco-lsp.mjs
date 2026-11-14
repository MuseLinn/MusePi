#!/usr/bin/env bun
/** Real Electron verification for Monaco's daemon-backed language features.
 * Run through scripts/dev-smoke.ts so sessions and daemon state stay isolated. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import puppeteer from "puppeteer-core";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixture = path.join(repoRoot, ".tmp", `monaco-lsp-e2e-${process.pid}`);
const reportPath = path.join(repoRoot, ".tmp", "monaco-lsp-e2e-report.json");
const screenshotPath = path.join(repoRoot, ".tmp", "monaco-lsp-e2e.png");
const peekScreenshotPath = path.join(repoRoot, ".tmp", "monaco-peek-e2e.png");
const referencesScreenshotPath = path.join(repoRoot, ".tmp", "monaco-references-peek-e2e.png");
const renameScreenshotPath = path.join(repoRoot, ".tmp", "monaco-rename-e2e.png");
const markdownScreenshotPath = path.join(repoRoot, ".tmp", "markdown-wysiwyg-e2e.png");
const sourcePath = path.join(fixture, "source.ts");
const targetPath = path.join(fixture, "target.ts");
const renameSourcePath = path.join(fixture, "rename-source.ts");
const renameTargetPath = path.join(fixture, "rename-target.ts");
const markdownPath = path.join(fixture, "docs", "guide.md");
const frontMatterPath = path.join(fixture, "docs", "front-matter.md");
const longFilePath = path.join(
	fixture,
	"first-long-directory",
	"second-long-directory",
	"third-long-directory",
	"a-file-with-a-long-name.txt",
);
const treeScreenshotPath = path.join(repoRoot, ".tmp", "file-tree-e2e.png");
const directoryScreenshotPath = path.join(repoRoot, ".tmp", "file-directory-menu-e2e.png");
const serverPath = path.join(fixture, "server.mjs");
const eventLog = path.join(fixture, "server-events.log");
const report = { assertions: [], completionLabels: [], runtimeErrors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const controlKey = async (page, key) => {
	await page.keyboard.down("Control");
	await page.keyboard.press(key);
	await page.keyboard.up("Control");
};
const altKey = async (page, key) => {
	await page.keyboard.down("Alt");
	await page.keyboard.press(key);
	await page.keyboard.up("Alt");
};

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

async function waitFor(fn, description, timeoutMs = 20_000) {
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
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "monaco-lsp-fixture", private: true }));
fs.writeFileSync(sourcePath, `const alpha = 1;\nalpha;\nconst horizontalOverflow = "${"x".repeat(360)}";\n`);
fs.writeFileSync(targetPath, "const alpha = 1;\nconst second = alpha;\n");
fs.writeFileSync(renameSourcePath, "export const renameMe = 1;\nrenameMe;\n");
fs.writeFileSync(renameTargetPath, 'import { renameMe } from "./rename-source";\nconsole.log(renameMe);\n');
fs.writeFileSync(path.join(fixture, "other.txt"), "other\n");
fs.mkdirSync(path.dirname(longFilePath), { recursive: true });
fs.writeFileSync(longFilePath, "long breadcrumb\n");
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, "# Guide\n\nInitial **content**.\n");
fs.writeFileSync(frontMatterPath, "---\ntitle: Keep this exact source\ncustom_field: unchanged\n---\n# Front Matter\n");
fs.writeFileSync(
	serverPath,
	`import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
let input = Buffer.alloc(0);
const documents = new Map();
const eventLog = ${JSON.stringify(eventLog)};
const targetUri = pathToFileURL(path.join(process.cwd(), "target.ts")).href;
const renameSourceUri = pathToFileURL(path.join(process.cwd(), "rename-source.ts")).href;
const renameTargetUri = pathToFileURL(path.join(process.cwd(), "rename-target.ts")).href;
function send(message) {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function diagnostics(uri) {
	send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{
		range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
		severity: 2, source: "fixture", message: "fixture-diagnostic"
	}] } });
}
function handle(message) {
	if (message.method) fs.appendFileSync(eventLog, message.method + "\\n");
	if (message.method === "initialize") {
		send({ id: message.id, result: { capabilities: {
			textDocumentSync: 1, hoverProvider: true, completionProvider: {}, definitionProvider: true,
			implementationProvider: true, typeDefinitionProvider: true, referencesProvider: true, renameProvider: true
		} } });
		return;
	}
	if (message.method === "shutdown") { send({ id: message.id, result: null }); return; }
	if (message.method === "exit") process.exit(0);
	if (message.method === "textDocument/didOpen") {
		const document = message.params.textDocument;
		documents.set(document.uri, document.text);
		diagnostics(document.uri);
		return;
	}
	if (message.method === "textDocument/didChange") {
		const uri = message.params.textDocument.uri;
		documents.set(uri, message.params.contentChanges.at(-1).text);
		diagnostics(uri);
		return;
	}
	if (message.method === "textDocument/hover") {
		send({ id: message.id, result: { contents: { kind: "markdown", value: "fixture-hover" },
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } } });
		return;
	}
	if (message.method === "textDocument/completion") {
		send({ id: message.id, result: { isIncomplete: false, items: [
			{ label: "fixtureCompletion", kind: 3, detail: "fixture-detail", sortText: "000" },
			{ label: "alpha", kind: 6, detail: "fixture-alpha", sortText: "001" }
		] } });
		return;
	}
	if (["textDocument/definition", "textDocument/implementation", "textDocument/typeDefinition"].includes(message.method)) {
		send({ id: message.id, result: [{ uri: targetUri, range: {
			start: { line: 1, character: 15 }, end: { line: 1, character: 20 }
		} }] });
		return;
	}
	if (message.method === "textDocument/references") {
		if (message.params.context.includeDeclaration !== true) {
			send({ id: message.id, error: { code: -32602, message: "Peek must include declarations" } });
			return;
		}
		send({ id: message.id, result: [
			{ uri: targetUri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } },
			{ uri: targetUri, range: { start: { line: 1, character: 15 }, end: { line: 1, character: 20 } } }
		] });
		return;
	}
	if (message.method === "textDocument/rename") {
		const newText = message.params.newName;
		const edit = (line, character) => ({ range: {
			start: { line, character }, end: { line, character: character + 8 }
		}, newText });
		send({ id: message.id, result: { documentChanges: [
			{ textDocument: { uri: renameSourceUri, version: null }, edits: [edit(0, 13), edit(1, 0)] },
			{ textDocument: { uri: renameTargetUri, version: null }, edits: [edit(0, 9), edit(1, 12)] }
		] } });
		return;
	}
	if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Unsupported" } });
}
process.stdin.on("data", chunk => {
	input = Buffer.concat([input, chunk]);
	while (true) {
		const headerEnd = input.indexOf("\\r\\n\\r\\n");
		if (headerEnd < 0) return;
		const header = input.subarray(0, headerEnd).toString("ascii");
		const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1]);
		if (!Number.isInteger(length)) process.exit(2);
		if (input.length < headerEnd + 4 + length) return;
		const body = input.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
		input = input.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body));
	}
});
`,
);
fs.writeFileSync(
	path.join(fixture, "lsp.json"),
	JSON.stringify({
		servers: {
			fixture: {
				command: process.execPath,
				args: [serverPath],
				fileTypes: [".ts"],
				rootMarkers: ["package.json"],
			},
		},
	}),
);

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
			"      - id: fake-editor",
			"        name: Fake Editor",
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
	const cdp = await page.createCDPSession();
	report.viewport = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
		devicePixelRatio: window.devicePixelRatio,
	}));
	page.on("pageerror", error => report.runtimeErrors.push(error.message));
	page.on("console", message => {
		if (message.type() === "error") report.runtimeErrors.push(message.text());
	});
	await waitFor(() => page.$(".gui-header"), "GUI header", 35_000);
	await page.evaluate(() => localStorage.setItem("musepi-gui-onboarding-done", "1"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitFor(() => page.$(".gui-header"), "GUI header after onboarding setup", 25_000);
	await sleep(800);
	if (!(await page.$(".gui-session-row"))) {
		console.log("Creating the isolated editor session");
		const created = await daemonRequest(daemonPort, "session.create", {
			cwd: fixture,
			autoTitle: false,
			modelPattern: "fake/fake-editor",
		});
		const sessionId = created.sessionId;
		report.sessionId = sessionId;
		console.log("Created isolated session", sessionId);
		await waitFor(
			() => page.evaluate(() => Boolean(document.querySelector(".gui-session-row"))),
			"created session row",
			25_000,
		);
		await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
		console.log("Selected isolated session");
		await waitFor(() => page.$(".gui-transcript"), "selected session", 15_000);
	}
	const openFile = async filePath => {
		await page.evaluate(target => {
			window.dispatchEvent(new CustomEvent("musepi-open-file", { detail: { path: target } }));
		}, filePath);
	};
	await openFile(sourcePath);
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "source.ts";
	}, "source preview");
	assert("external open uses a preview tab", Boolean(await page.$(".gui-surface-tab--preview")));
	await waitFor(() => page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"), "Monaco editor");
	report.directSync = await daemonRequest(daemonPort, "editor.sync", {
		cwd: fixture,
		path: sourcePath,
		content: fs.readFileSync(sourcePath, "utf8"),
	});
	report.serverEvents = fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8").split(/\r?\n/).filter(Boolean) : [];
	await page.focus(".monaco-editor .native-edit-context");
	await page.keyboard.press("F8");
	report.markerText = await waitFor(async () => {
		const text = await page.$eval(".marker-widget", element => element.textContent).catch(() => "");
		return text?.includes("fixture-diagnostic") ? text : null;
	}, "diagnostic marker widget", 8_000);
	assert("real LSP diagnostics reach Monaco", true, report.markerText);
	await page.keyboard.press("Escape");

	const editorHandle = await page.$(".monaco-editor");
	const editorBox = await editorHandle?.boundingBox();
	if (!editorBox) throw new Error("Monaco editor is not visible");
	await page.bringToFront();
	await page.mouse.click(editorBox.x + 90, editorBox.y + 28);
	await page.focus(".monaco-editor .native-edit-context");
	await controlKey(page, "Home");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Home");
	await page.keyboard.press("F1");
	await page.keyboard.type("Show or Focus Hover");
	await page.keyboard.press("Enter");
	report.hoverText = await waitFor(async () => {
		const text = await page.$eval(".monaco-hover", element => element.textContent).catch(() => "");
		return text?.includes("fixture-hover") ? text : null;
	}, "daemon hover widget", 8_000);
	assert("daemon hover reaches Monaco", true, report.hoverText);
	await page.keyboard.press("Escape");

	await page.focus(".monaco-editor .native-edit-context");
	await altKey(page, "F12");
	report.peekText = await waitFor(async () => {
		const text = await page.$eval(".peekview-widget", element => element.textContent).catch(() => "");
		return text?.replace(/\s+/g, " ").includes("second = alpha;") ? text : null;
	}, "definition peek loads the unopened target", 8_000);
	assert("definition peek loads the unopened target", true, report.peekText);
	await page.screenshot({ path: peekScreenshotPath });
	report.peekScreenshot = peekScreenshotPath;
	await page.focus(".peekview-widget .monaco-editor .native-edit-context");
	await controlKey(page, "End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("peek");
	await controlKey(page, "s");
	const peekSavedContent = await waitFor(() => {
		const content = fs.readFileSync(targetPath, "utf8");
		return content.endsWith("\npeek") ? content : null;
	}, "peek edit saves through the file service", 8_000);
	assert("peek edit saves through the file service", true, peekSavedContent);
	assert(
		"peek editing keeps the source file tab active",
		(await page.$eval(".gui-filepane-preview-name", element => element.textContent)) === "source.ts",
	);
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".peekview-widget")), "definition peek closes");

	await page.focus(".monaco-editor .native-edit-context");
	await page.keyboard.down("Shift");
	await page.keyboard.press("F12");
	await page.keyboard.up("Shift");
	report.referencesPeekText = await waitFor(async () => {
		const text = await page.$eval(".peekview-widget", element => element.textContent).catch(() => "");
		const normalized = text?.replace(/\s+/g, " ") ?? "";
		return normalized.includes("References (2)") && normalized.includes("second = alpha;") ? normalized : null;
	}, "reference peek loads both results", 8_000);
	assert("Shift+F12 opens daemon reference peek with both results", true, report.referencesPeekText);
	assert(
		"reference peek keeps the source file tab active",
		(await page.$eval(".gui-filepane-preview-name", element => element.textContent)) === "source.ts",
	);
	report.referencesPeekStyle = await page.$eval(".peekview-widget", element => {
		const style = getComputedStyle(element);
		const preview = element.querySelector(".preview .monaco-editor .monaco-editor-background");
		const tree = element.querySelector(".ref-tree");
		return {
			borderRadius: style.borderRadius,
			backgroundImage: style.backgroundImage,
			backdropFilter: style.backdropFilter,
			previewBackground: preview ? getComputedStyle(preview).backgroundColor : null,
			treeBackground: tree ? getComputedStyle(tree).backgroundColor : null,
		};
	});
	assert("reference peek uses the shared glass radius", report.referencesPeekStyle.borderRadius === "12px", report.referencesPeekStyle);
	assert(
		"reference peek uses glass sheen and backdrop blur",
		report.referencesPeekStyle.backgroundImage !== "none" && report.referencesPeekStyle.backdropFilter.includes("blur"),
		report.referencesPeekStyle,
	);
	assert(
		"reference peek reveals glass through its result surfaces",
		[report.referencesPeekStyle.previewBackground, report.referencesPeekStyle.treeBackground].every(
			color => color === "rgba(0, 0, 0, 0)" || color === "transparent",
		),
		report.referencesPeekStyle,
	);
	await page.screenshot({ path: referencesScreenshotPath });
	report.referencesPeekScreenshot = referencesScreenshotPath;
	await page.focus(".peekview-widget .monaco-editor .native-edit-context");
	await controlKey(page, "End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("referencePeek");
	await controlKey(page, "s");
	const referencePeekSavedContent = await waitFor(() => {
		const content = fs.readFileSync(targetPath, "utf8");
		return content.endsWith("\npeek\nreferencePeek") ? content : null;
	}, "reference peek edit saves through the file service", 8_000);
	assert("reference peek edit saves through the file service", true, referencePeekSavedContent);
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".peekview-widget")), "reference peek closes");

	await page.focus(".monaco-editor .native-edit-context");
	await controlKey(page, "End");
	await page.keyboard.press("Enter");
	await controlKey(page, "Space");
	report.completionLabels = await waitFor(async () => {
		const labels = await page.$$eval(".suggest-widget.visible .monaco-list-row .label-name", elements =>
			elements.map(element => element.textContent ?? ""),
		);
		return labels.includes("fixtureCompletion") ? labels : null;
	}, "completion widget", 8_000);
	assert(
		"real LSP completion reaches Monaco once",
		report.completionLabels.filter(label => label === "fixtureCompletion").length === 1,
		report.completionLabels,
	);
	assert(
		"TypeScript and daemon completions do not duplicate alpha",
		report.completionLabels.filter(label => label === "alpha").length <= 1,
		report.completionLabels,
	);
	await page.keyboard.press("Escape");
	await cdp.send("Input.insertText", { text: "a" });
	await controlKey(page, "s");
	const sourceContent = await waitFor(() => {
		const events = fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8") : "";
		const content = fs.readFileSync(sourcePath, "utf8");
		return events.includes("textDocument/didSave") && content.endsWith("\na") ? content : null;
	}, "disk save and save notification", 8_000);
	assert("disk save persists Monaco text and sends didSave", true, sourceContent);

	await page.keyboard.press("F12");
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "target.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "cross-file definition editor", 10_000);
	await sleep(500);
	await page.focus(".monaco-editor .native-edit-context");
	await cdp.send("Input.insertText", { text: "X" });
	await controlKey(page, "s");
	const targetContent = await waitFor(async () => {
		const content = fs.readFileSync(targetPath, "utf8");
		return content.includes("X") ? content : null;
	}, "definition target edit", 8_000);
	assert("definition places the cursor on target line 2", targetContent.includes("const second = Xalpha;"), targetContent);
	assert("definition target opens as a pinned tab", !(await page.$(".gui-surface-tab--active.gui-surface-tab--preview")));
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "definition target clean state");

	await altKey(page, "ArrowLeft");
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "source.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "history back to source editor", 10_000);
	const labelsAfterBack = await page.$$eval(".gui-surface-tab", elements => elements.map(element => element.textContent ?? ""));
	assert("history back reuses the original source tab", labelsAfterBack.filter(label => label.includes("source.ts")).length === 1, labelsAfterBack);
	await page.focus(".monaco-editor .native-edit-context");
	await cdp.send("Input.insertText", { text: "B" });
	await controlKey(page, "s");
	const backSourceContent = await waitFor(() => {
		const content = fs.readFileSync(sourcePath, "utf8");
		return content.endsWith("\naB") ? content : null;
	}, "source cursor restored by history back", 8_000);
	assert("history back restores the exact source cursor", backSourceContent.endsWith("\naB"), backSourceContent);
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "source clean after history back");

	await altKey(page, "ArrowRight");
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "target.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "history forward to definition editor", 10_000);
	await page.focus(".monaco-editor .native-edit-context");
	await cdp.send("Input.insertText", { text: "Y" });
	await controlKey(page, "s");
	const forwardTargetContent = await waitFor(() => {
		const content = fs.readFileSync(targetPath, "utf8");
		return content.includes("XYalpha") ? content : null;
	}, "target cursor restored by history forward", 8_000);
	assert(
		"history forward restores the latest target cursor",
		forwardTargetContent.includes("const second = XYalpha;"),
		forwardTargetContent,
	);
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "target clean after history forward");

	await altKey(page, "ArrowLeft");
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "source.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "second history back", 10_000);
	await page.focus(".monaco-editor .native-edit-context");
	await page.keyboard.press("F12");
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "target.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "new definition after history back", 10_000);
	await waitFor(async () => await page.$eval(".gui-filepane-history-forward", element => element.disabled), "forward history truncated");
	assert("a new definition jump clears forward history", true);
	await altKey(page, "ArrowRight");
	await sleep(300);
	assert(
		"Alt+Right stays put after forward history is cleared",
		(await page.$eval(".gui-filepane-preview-name", element => element.textContent)) === "target.ts",
	);

	for (const navigation of [
		{ name: "implementation", key: "F12", lspMethod: "textDocument/implementation", alt: false },
		{ name: "type definition", key: "F12", lspMethod: "textDocument/typeDefinition", alt: true },
	]) {
		await altKey(page, "ArrowLeft");
		await waitFor(async () => {
			const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
			return name === "source.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .native-edit-context"));
		}, `return before ${navigation.name}`);
		await page.focus(".gui-filepane-editor-monaco[data-ready] .native-edit-context");
		if (navigation.alt) await page.keyboard.down("Alt");
		await controlKey(page, navigation.key);
		if (navigation.alt) await page.keyboard.up("Alt");
		await waitFor(async () => {
			const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
			return name === "target.ts";
		}, `${navigation.name} cross-file navigation`);
		assert(`${navigation.name} reaches the real LSP server`, fs.readFileSync(eventLog, "utf8").includes(navigation.lspMethod));
	}

	await openFile(markdownPath);
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "guide.md" && Boolean(await page.$(".gui-filepane-markdown-editor[data-ready] .ProseMirror[contenteditable='true']"));
	}, "Markdown visual editor", 15_000);
	assert("Markdown opens as one editable visual column", !(await page.$(".gui-filepane-editor-monaco")) && !(await page.$(".gui-filepane-preview-md--live")));
	assert("Markdown visual editor has a top formatting toolbar", Boolean(await page.$(".milkdown-top-bar .top-bar-item")));
	assert("opening Markdown does not mark it dirty", !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")));

	await page.evaluate(() => {
		const root = document.querySelector(".gui-filepane-markdown-editor .ProseMirror");
		if (!root) throw new Error("Markdown editor is missing");
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		let last = node;
		while (node) {
			last = node;
			node = walker.nextNode();
		}
		if (!last) throw new Error("Markdown fixture has no text");
		const range = document.createRange();
		range.setStart(last, last.textContent?.length ?? 0);
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		root.focus();
		document.dispatchEvent(new Event("selectionchange"));
	});
	await page.keyboard.press("Enter");
	await cdp.send("Input.insertText", { text: "Visual draft" });
	await page.keyboard.down("Shift");
	await page.keyboard.press("Home");
	await page.keyboard.up("Shift");
	// ProseMirror publishes a keyboard-driven DOM selection asynchronously.
	// Wait for that selection before invoking a formatting command.
	await sleep(300);
	const boldPoint = await page.$eval('.top-bar-item:is([aria-label="Bold"], [aria-label="粗体"])', element => {
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
		const rect = element.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	});
	await page.mouse.click(boldPoint.x, boldPoint.y);
	await waitFor(async () => {
		const bold = await page.$eval(".gui-filepane-markdown-editor .ProseMirror", element =>
			[...element.querySelectorAll("strong")].some(item => item.textContent === "Visual draft"),
		);
		return bold || null;
	}, "visual bold command");
	await page.evaluate(() => {
		const source = [...document.querySelectorAll(".gui-seg--compact .gui-seg-item")].find(el => ["Source code", "源码"].includes(el.textContent?.trim() ?? ""));
		source?.click();
	});
	await waitFor(() => page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"), "Markdown source mode");
	await page.bringToFront();
	await page.focus(".gui-filepane-editor-monaco .native-edit-context");
	report.markdownDirtyBeforeSource = Boolean(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty"));
	const sourceText = await waitFor(async () => {
		const text = await page.$$eval(".gui-filepane-preview-body .gui-filepane-editor-monaco .view-lines", elements =>
			elements.map(element => element.textContent ?? "").join("\n"),
		);
		report.sourceText = text;
		return /Visual\s+draft/.test(text) ? text : null;
	}, "visual Markdown reaches source mode");
	assert("the visual bold command changes real Markdown source", /\*\*Visual\s+draft\*\*/.test(sourceText), sourceText);
	await page.evaluate(() => {
		const rendered = [...document.querySelectorAll(".gui-seg--compact .gui-seg-item")].find(el => ["Rendered", "渲染"].includes(el.textContent?.trim() ?? ""));
		rendered?.click();
	});
	await waitFor(() => page.$(".gui-filepane-markdown-editor[data-ready] .ProseMirror"), "return to visual Markdown");
	assert("source round trip preserves the unsaved visual edit", (await page.$eval(".gui-filepane-markdown-editor .ProseMirror", el => el.textContent))?.includes("Visual draft"));

	await page.evaluate(() => {
		const root = document.querySelector(".gui-filepane-markdown-editor .ProseMirror");
		if (!root) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node && !node.textContent?.includes("Visual draft")) node = walker.nextNode();
		if (!node) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	});
	const selectionActions = await waitFor(async () => {
		const buttons = await page.$$(".gui-select-pop .gui-select-pop-btn");
		return buttons.length === 5 ? buttons : null;
	}, "five visual Markdown selection actions");
	assert("visual Markdown selection exposes all five actions", selectionActions.length === 5);
	report.selectionToolbarGeometry = await page.evaluate(() => {
		const agent = document.querySelector(".gui-select-pop")?.getBoundingClientRect();
		const editor = document.querySelector('.milkdown-toolbar[data-show="true"]')?.getBoundingClientRect();
		if (!agent || !editor) return null;
		return {
			agent: { left: agent.left, right: agent.right, top: agent.top, bottom: agent.bottom },
			editor: { left: editor.left, right: editor.right, top: editor.top, bottom: editor.bottom },
			intersects: agent.left < editor.right && agent.right > editor.left && agent.top < editor.bottom && agent.bottom > editor.top,
		};
	});
	assert("Agent and Crepe selection toolbars do not overlap", report.selectionToolbarGeometry?.intersects === false, report.selectionToolbarGeometry);
	// Keep the later divider insertion from replacing the selected draft text.
	await page.evaluate(() => {
		const root = document.querySelector(".gui-filepane-markdown-editor .ProseMirror");
		if (!(root instanceof HTMLElement)) return;
		root.focus();
		window.getSelection()?.collapseToEnd();
		document.dispatchEvent(new Event("selectionchange"));
	});

	await page.click(".top-bar-heading-button");
	await waitFor(() => page.$(".top-bar-heading-dropdown"), "Markdown heading dropdown");
	report.headingDropdown = await page.evaluate(() => {
		const dropdown = document.querySelector(".top-bar-heading-dropdown");
		const inner = document.querySelector(".milkdown-top-bar .top-bar-inner");
		if (!(dropdown instanceof HTMLElement) || !(inner instanceof HTMLElement)) return null;
		const rect = dropdown.getBoundingClientRect();
		const parent = inner.getBoundingClientRect();
		const style = getComputedStyle(dropdown);
		return {
			dropdown: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
			parent: { top: parent.top, bottom: parent.bottom, left: parent.left, right: parent.right },
			display: style.display,
			visibility: style.visibility,
			opacity: style.opacity,
			uncut: rect.bottom <= parent.bottom || getComputedStyle(inner).overflowY === "visible",
		};
	});
	assert(
		"Markdown heading dropdown is visible and not clipped",
		report.headingDropdown?.uncut === true && report.headingDropdown?.display !== "none" && report.headingDropdown?.visibility !== "hidden" && Number(report.headingDropdown?.opacity) > 0,
		report.headingDropdown,
	);
	await page.click(".top-bar-heading-button");
	report.markdownToolbar = await page.evaluate(() => {
		const inner = document.querySelector(".milkdown-top-bar .top-bar-inner");
		const more = document.querySelector(".gui-filepane-markdown-more");
		if (!(inner instanceof HTMLElement) || !(more instanceof HTMLElement)) return null;
		const visible = [...inner.querySelectorAll(":scope > .top-bar-item, :scope > .gui-filepane-markdown-more")].filter(
			child => child instanceof HTMLElement && !child.hidden && child.getBoundingClientRect().width > 0,
		);
		return {
			height: inner.getBoundingClientRect().height,
			tops: visible.map(child => child.getBoundingClientRect().top),
			moreVisible: !more.hidden,
			overflowCount: Number(more.getAttribute("data-overflow-count") ?? 0),
		};
	});
	assert(
		"Markdown toolbar stays on one row and collects overflow actions",
		report.markdownToolbar?.moreVisible === true &&
			report.markdownToolbar.overflowCount > 0 &&
			report.markdownToolbar.height <= 36 &&
			report.markdownToolbar.tops.every(top => Math.abs(top - report.markdownToolbar.tops[0]) <= 1),
		report.markdownToolbar,
	);
	await page.click(".gui-filepane-markdown-more");
	await waitFor(() => page.$(".gui-filepane-markdown-overflow-item"), "Markdown more-actions menu");
	report.markdownOverflowLabels = await page.$$eval(".gui-filepane-markdown-overflow-item", elements =>
		elements.map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? ""),
	);
	assert("Markdown more-actions menu contains the hidden commands", report.markdownOverflowLabels.includes("分割线"), report.markdownOverflowLabels);
	const markdownOverflowScreenshotPath = path.join(repoRoot, ".tmp", "markdown-toolbar-overflow-e2e.png");
	await page.screenshot({ path: markdownOverflowScreenshotPath });
	report.markdownOverflowScreenshot = markdownOverflowScreenshotPath;
	await page.evaluate(() => {
		const divider = [...document.querySelectorAll(".gui-filepane-markdown-overflow-item")].find(
			element => element.textContent?.replace(/\s+/g, " ").trim() === "分割线",
		);
		divider?.click();
	});
	await waitFor(() => page.$(".ProseMirror hr"), "Markdown overflow divider command");
	assert("Markdown more action invokes the original editor command", true);
	await page.click('.gui-filepane-path-part[title="docs"]');
	await waitFor(() => page.$(".gui-filepane-directory-menu .gui-filepane-directory-entry"), "anchored breadcrumb directory menu");
	assert("selection toolbar leaves the breadcrumb clickable", true);
	assert("directory menu uses shared edge fading", Boolean(await page.$(".gui-filepane-directory-list.gui-fade-scroll")));
	assert("directory menu is non-modal", !(await page.$(".gui-dialog-backdrop")));
	report.directoryMenuGeometry = await waitFor(async () => {
		const geometry = await page.evaluate(() => {
			const menu = document.querySelector(".gui-filepane-directory-menu")?.getBoundingClientRect();
			const anchorElement = [...document.querySelectorAll(".gui-filepane-path-part")].find(
				element => element.textContent?.trim() === "docs",
			);
			const anchor = anchorElement?.getBoundingClientRect();
			if (!menu || !anchor) return null;
			return { menuLeft: menu.left, menuTop: menu.top, anchorLeft: anchor.left, anchorBottom: anchor.bottom };
		});
		return geometry ?? null;
	}, "directory menu and breadcrumb geometry");
	assert(
		"directory menu stays beside its breadcrumb anchor",
		Math.abs(report.directoryMenuGeometry.menuLeft - report.directoryMenuGeometry.anchorLeft) <= 2 &&
			report.directoryMenuGeometry.menuTop >= report.directoryMenuGeometry.anchorBottom,
		report.directoryMenuGeometry,
	);
	await waitFor(() => page.$(".gui-filepane-directory-search input"), "directory search input");
	await page.$eval(".gui-filepane-directory-search input", element => element.focus());
	await page.keyboard.type("not-a-file");
	await waitFor(() => page.$(".gui-filepane-directory-menu .gui-filepane-empty"), "directory search empty state");
	await controlKey(page, "a");
	await page.keyboard.type("guide");
	await waitFor(async () => (await page.$$eval(".gui-filepane-directory-entry", elements => elements.map(element => element.textContent))).join() === "guide.md", "directory search filter");
	assert("directory search filters the current listing", true);
	await page.screenshot({ path: directoryScreenshotPath });
	report.directoryScreenshot = directoryScreenshotPath;
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".gui-filepane-directory-menu")), "directory menu close");

	await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: fixture });
	await page.evaluate(() => document.querySelector(".gui-filepane-export-word")?.click());
	const wordPath = path.join(fixture, "guide.docx");
	await waitFor(() => fs.existsSync(wordPath) && fs.statSync(wordPath).size > 1000, "Word download");
	const wordXml = strFromU8(unzipSync(fs.readFileSync(wordPath))["word/document.xml"]);
	assert("Word export contains unsaved visual Markdown", wordXml.includes("Visual") && wordXml.includes("draft"));
	await page.$eval(".gui-filepane-markdown-editor .ProseMirror", element => element.focus());
	await controlKey(page, "s");
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "Markdown clean state after visual save");
	assert("visual Markdown save persists the toolbar edit", fs.readFileSync(markdownPath, "utf8").includes("**Visual draft**"));
	await page.screenshot({ path: markdownScreenshotPath });
	report.markdownScreenshot = markdownScreenshotPath;

	await openFile(frontMatterPath);
	await waitFor(async () =>
		Boolean(await page.$(".gui-filepane-markdown-editor[data-ready] .ProseMirror")) && Boolean(await page.$(".gui-filepane-markdown-warning")),
	"Front Matter warning");
	assert("Front Matter warning appears without marking the file dirty", !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")));
	await page.click(".gui-filepane-markdown-warning button");
	await waitFor(() => page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"), "Front Matter source mode");
	const frontMatterSource = await waitFor(async () => {
		const text = await page.$eval(".gui-filepane-editor-monaco .view-lines", element => element.textContent ?? "").catch(() => "");
		return text.includes("custom_field") ? text : null;
	}, "Front Matter original source");
	assert("Front Matter source action preserves the original metadata", frontMatterSource.includes("title:") && frontMatterSource.includes("custom_field:"));
	assert("opening the Front Matter warning's source action keeps disk unchanged", fs.readFileSync(frontMatterPath, "utf8").includes("title: Keep this exact source"));

	await page.evaluate(() => {
		const files = [...document.querySelectorAll(".gui-right-rail-btn")].find(el => ["Files", "文件"].includes(el.getAttribute("aria-label") ?? ""));
		files?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
	});
	await waitFor(() => page.$(".gui-filepane-file-btn"), "new tree-only tab");
	await page.evaluate(() => {
		const other = [...document.querySelectorAll(".gui-filepane-file-btn")].find(el => el.textContent === "other.txt");
		other?.click();
	});
	await waitFor(async () => (await page.$eval(".gui-filepane-preview-name", el => el.textContent).catch(() => null)) === "other.txt", "tree's first file");
	const labelsAfterFirstFile = await waitFor(async () => {
		const labels = await page.$$eval(".gui-surface-tab", elements => elements.map(el => el.textContent ?? ""));
		return labels.some(label => ["Files", "文件"].includes(label.trim())) ? null : labels;
	}, "tree-only tab consumed by its first file");
	assert("first file consumes the tree-only tab", true, labelsAfterFirstFile);
	await page.evaluate(() => document.querySelector(".gui-filepane-tree-toggle")?.click());
	await waitFor(() => page.$(".gui-filepane-preview-main--tree-open"), "file page inline tree");
	await page.evaluate(() => {
		const source = [...document.querySelectorAll(".gui-filepane-file-btn")].find(el => el.textContent === "source.ts");
		source?.click();
	});
	await waitFor(async () => (await page.$eval(".gui-filepane-preview-name", el => el.textContent).catch(() => null)) === "source.ts", "inline tree opens source file");
	const labelsAfterSecondFile = await page.$$eval(".gui-surface-tab", elements => elements.map(el => el.textContent ?? ""));
	assert("inline tree preserves the previous file tab", labelsAfterSecondFile.some(label => label.includes("other.txt")), labelsAfterSecondFile);
	const headerBeforeTree = await page.$eval(".gui-filepane-preview-head", element => {
		const rect = element.getBoundingClientRect();
		return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
	});
	await page.evaluate(() => document.querySelector(".gui-filepane-tree-toggle")?.click());
	await waitFor(() => page.$(".gui-filepane-preview-main--tree-open"), "source file inline tree");
	await sleep(350);
	report.treeLayout = await page.evaluate(() => {
		const head = document.querySelector(".gui-filepane-preview-head")?.getBoundingClientRect();
		const tree = document.querySelector(".gui-filepane-list")?.getBoundingClientRect();
		const body = document.querySelector(".gui-filepane-preview-body")?.getBoundingClientRect();
		const toggle = document.querySelector(".gui-filepane-tree-toggle")?.getBoundingClientRect();
		const path = document.querySelector(".gui-filepane-preview-path")?.getBoundingClientRect();
		const editor = document.querySelector(".monaco-editor .monaco-scrollable-element");
		return {
			head: head ? { top: head.top, left: head.left, width: head.width, height: head.height } : null,
			tree: tree ? { top: tree.top, left: tree.left, right: tree.right, width: tree.width } : null,
			body: body ? { top: body.top, left: body.left, width: body.width } : null,
			togglePathGap: toggle && path ? path.left - toggle.right : null,
			editorScrollWidth: editor?.scrollWidth ?? 0,
			editorClientWidth: editor?.clientWidth ?? 0,
		};
	});
	assert("tree expansion does not move or resize the path header", JSON.stringify(report.treeLayout.head) === JSON.stringify(headerBeforeTree), report.treeLayout);
	assert(
		"tree and file content are siblings in one row",
		Math.abs(report.treeLayout.tree?.top - report.treeLayout.body?.top) <= 1 &&
			Math.abs(report.treeLayout.tree?.right - report.treeLayout.body?.left) <= 1 &&
			report.treeLayout.tree?.width > 0,
		report.treeLayout,
	);
	assert("tree toggle sits next to the breadcrumb without a flex spacer", report.treeLayout.togglePathGap <= 12, report.treeLayout);
	assert("Monaco keeps long lines horizontally scrollable", report.treeLayout.editorScrollWidth > report.treeLayout.editorClientWidth, report.treeLayout);
	const labelsBeforeSameFile = await page.$$eval(".gui-surface-tab", elements => elements.map(element => element.textContent ?? ""));
	await page.evaluate(() => {
		const source = [...document.querySelectorAll(".gui-filepane-file-btn")].find(element => element.textContent === "source.ts");
		source?.click();
	});
	await sleep(250);
	assert(
		"clicking the current tree file does not duplicate its tab",
		JSON.stringify(await page.$$eval(".gui-surface-tab", elements => elements.map(element => element.textContent ?? ""))) === JSON.stringify(labelsBeforeSameFile),
	);
	await page.screenshot({ path: treeScreenshotPath });
	report.treeScreenshot = treeScreenshotPath;

	await openFile(longFilePath);
	await waitFor(async () => (await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null)) === "a-file-with-a-long-name.txt", "long breadcrumb file");
	report.breadcrumbOverflow = await page.evaluate(() => {
		const path = document.querySelector(".gui-filepane-preview-path");
		const name = document.querySelector(".gui-filepane-preview-name")?.getBoundingClientRect();
		const tools = document.querySelector(".gui-filepane-preview-tools");
		const bounds = path?.getBoundingClientRect();
		return {
			scrollWidth: path?.scrollWidth ?? 0,
			clientWidth: path?.clientWidth ?? 0,
			scrollLeft: path?.scrollLeft ?? 0,
			nameRight: name?.right ?? 0,
			pathRight: bounds?.right ?? 0,
			toolsWidth: tools?.getBoundingClientRect().width ?? 0,
			toolsBounds: tools ? { left: tools.getBoundingClientRect().left, right: tools.getBoundingClientRect().right } : null,
			toolsClientWidth: tools?.clientWidth ?? 0,
			toolsScrollWidth: tools?.scrollWidth ?? 0,
			toolsChildren: tools
				? [...tools.children].map(element => {
						const rect = element.getBoundingClientRect();
						const style = getComputedStyle(element);
						return { left: rect.left, right: rect.right, width: rect.width, marginLeft: style.marginLeft, marginRight: style.marginRight };
					})
				: [],
			// Child geometry is the clipping contract. A flex item's scrollWidth can
			// include non-visual overflow even when every button is fully visible.
			toolsOverflow: tools
				? [...tools.children].some(element => {
						const rect = element.getBoundingClientRect();
						const parent = tools.getBoundingClientRect();
						return rect.left < parent.left - 1 || rect.right > parent.right + 1;
					})
				: true,
		};
	});
	const breadcrumbScreenshotPath = path.join(repoRoot, ".tmp", "file-breadcrumb-tools-e2e.png");
	await page.screenshot({ path: breadcrumbScreenshotPath });
	report.breadcrumbScreenshot = breadcrumbScreenshotPath;
	assert(
		"long breadcrumbs scroll while preserving the filename and tools",
		report.breadcrumbOverflow.scrollWidth > report.breadcrumbOverflow.clientWidth && report.breadcrumbOverflow.scrollLeft > 0 && report.breadcrumbOverflow.nameRight <= report.breadcrumbOverflow.pathRight + 1 && report.breadcrumbOverflow.toolsWidth > 0 && !report.breadcrumbOverflow.toolsOverflow,
		report.breadcrumbOverflow,
	);

	await openFile(renameSourcePath);
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		return name === "rename-source.ts" && Boolean(await page.$(".gui-filepane-editor-monaco[data-ready] .monaco-editor"));
	}, "rename source editor", 10_000);
	await page.focus(".monaco-editor .native-edit-context");
	await controlKey(page, "Home");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Home");
	await page.keyboard.press("F2");
	await waitFor(async () => {
		const value = await page.$eval(".rename-box .rename-input", element => element.value).catch(() => null);
		return value === "renameMe";
	}, "native F2 rename input", 8_000);
	report.renameStyle = await page.$eval(".rename-box", element => {
		const style = getComputedStyle(element);
		const input = element.querySelector(".rename-input");
		const inputStyle = input ? getComputedStyle(input) : null;
		return {
			borderRadius: style.borderRadius,
			backgroundImage: style.backgroundImage,
			backdropFilter: style.backdropFilter,
			height: element.getBoundingClientRect().height,
			inputHeight: input?.getBoundingClientRect().height ?? 0,
			inputColor: inputStyle?.color ?? null,
		};
	});
	assert("F2 opens Monaco's native rename input", true);
	assert(
		"rename widget sizes to its input instead of the full editor",
		report.renameStyle.height > 20 && report.renameStyle.height < 80 && report.renameStyle.inputHeight > 10,
		report.renameStyle,
	);
	assert("rename input uses the shared glass radius", report.renameStyle.borderRadius === "8px", report.renameStyle);
	assert(
		"rename input uses glass sheen and backdrop blur",
		report.renameStyle.backgroundImage !== "none" && report.renameStyle.backdropFilter.includes("blur"),
		report.renameStyle,
	);
	await page.screenshot({ path: renameScreenshotPath });
	report.renameScreenshot = renameScreenshotPath;
	await page.focus(".rename-box .rename-input");
	await controlKey(page, "a");
	await page.keyboard.type("renamedSymbol");
	await waitFor(async () => (await page.$eval(".rename-box .rename-input", element => element.value)) === "renamedSymbol", "rename input value");
	await page.keyboard.press("Enter");
	await waitFor(async () => {
		const text = await page.$eval(".gui-filepane-editor-monaco .view-lines", element => element.textContent).catch(() => "");
		return text?.includes("renamedSymbol") && Boolean(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty"));
	}, "cross-file rename applies to the source draft", 8_000);
	assert("rename edits the source draft", true);
	assert("rename marks the source file dirty", Boolean(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")));
	assert(
		"rename does not write either file before save",
		fs.readFileSync(renameSourcePath, "utf8").includes("renameMe") && fs.readFileSync(renameTargetPath, "utf8").includes("renameMe"),
	);

	await openFile(renameTargetPath);
	await waitFor(async () => {
		const name = await page.$eval(".gui-filepane-preview-name", element => element.textContent).catch(() => null);
		const text = await page.$eval(".gui-filepane-editor-monaco .view-lines", element => element.textContent).catch(() => "");
		return name === "rename-target.ts" && text?.includes("renamedSymbol") && Boolean(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty"));
	}, "unopened rename target retains its dirty draft", 10_000);
	assert("unopened rename target retains edits and dirty state", true);
	assert("unopened rename target is still unchanged on disk", fs.readFileSync(renameTargetPath, "utf8").includes("renameMe"));
	await page.focus(".monaco-editor .native-edit-context");
	await controlKey(page, "s");
	await waitFor(() => {
		const content = fs.readFileSync(renameTargetPath, "utf8");
		return content.includes("import { renamedSymbol }") && content.includes("console.log(renamedSymbol)");
	}, "save renamed target", 8_000);
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "renamed target clean state");
	assert("saving the target persists both target edits", true);

	await openFile(renameSourcePath);
	await waitFor(async () => (await page.$eval(".gui-filepane-preview-name", element => element.textContent)) === "rename-source.ts", "return to renamed source");
	assert("source remains dirty while saving only the target", Boolean(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")));
	assert("source remains unchanged on disk while saving only the target", fs.readFileSync(renameSourcePath, "utf8").includes("renameMe"));
	await page.focus(".monaco-editor .native-edit-context");
	await controlKey(page, "s");
	const renamedSourceContent = await waitFor(() => {
		const content = fs.readFileSync(renameSourcePath, "utf8");
		return content === "export const renamedSymbol = 1;\nrenamedSymbol;\n" ? content : null;
	}, "save renamed source", 8_000);
	await waitFor(async () => !(await page.$(".gui-surface-tab--active .gui-surface-tab-dirty")), "renamed source clean state");
	assert("saving the source persists both source edits", true, renamedSourceContent);

	report.serverEvents = fs.readFileSync(eventLog, "utf8").split(/\r?\n/).filter(Boolean);
	await page.screenshot({ path: screenshotPath });
	report.screenshot = screenshotPath;
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	report.error = error instanceof Error ? error.stack : String(error);
	report.electronOutput = electronOutput;
	report.electronExitCode = electron?.exitCode ?? null;
	if (browser) {
		const pages = await browser.pages();
		const page = pages.find(candidate => candidate.url().includes("dist/index.html"));
		if (page) {
			report.targetContent = fs.readFileSync(targetPath, "utf8");
			report.serverEvents = fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8").split(/\r?\n/).filter(Boolean) : [];
			report.activeElement = await page.evaluate(() => ({
				tag: document.activeElement?.tagName,
				class: document.activeElement?.className,
				aria: document.activeElement?.getAttribute("aria-label"),
			}));
			report.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 8_000);
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
}
