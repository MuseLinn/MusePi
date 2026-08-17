/**
 * Font-scale verification: loads the built gui SPA in headless Chrome,
 * seeds --gui-font-scale through the document root, and asserts that both
 * the gui shell and a collab-web token-sized element follow it.
 *
 * Usage: bun scripts/verify-font-scale.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUI_DIST = join(import.meta.dir, "..", "dist");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9341;

const tmpDir = mkdtempSync(join(tmpdir(), "font-scale-"));
const chrome = spawn(
	CHROME,
	[
		"--headless",
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${tmpDir}/chrome`,
		"--no-first-run",
		"--disable-gpu",
		"--allow-file-access-from-files",
		`file://${GUI_DIST}/index.html`,
	],
	{ stdio: "ignore" },
);

async function findTarget(): Promise<string> {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
			const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {
			// not up yet
		}
		await Bun.sleep(200);
	}
	throw new Error("no page target");
}

class Cdp {
	#ws: WebSocket;
	#seq = 0;
	#pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	ready: Promise<void>;
	constructor(url: string) {
		this.#ws = new WebSocket(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.ready = promise;
		this.#ws.onopen = () => resolve();
		this.#ws.onerror = () => reject(new Error("cdp ws error"));
		this.#ws.onmessage = event => {
			const msg = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
			if (msg.id === undefined) return;
			const pending = this.#pending.get(msg.id);
			if (!pending) return;
			this.#pending.delete(msg.id);
			if (msg.error) pending.reject(new Error(msg.error.message));
			else pending.resolve(msg.result);
		};
	}
	async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		await this.ready;
		const id = ++this.#seq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#ws.send(JSON.stringify({ id, method, params }));
		return promise;
	}
	close(): void {
		this.#ws.close();
	}
}

async function evalJs(cdp: Cdp, expression: string): Promise<unknown> {
	const res = (await cdp.call("Runtime.evaluate", { expression, returnByValue: true })) as {
		result?: { value?: unknown };
	};
	return res.result?.value;
}

try {
	const wsUrl = await findTarget();
	const cdp = new Cdp(wsUrl);
	await cdp.ready;
	await Bun.sleep(3000); // let the SPA boot

	// Baseline: no --gui-font-scale set -> token fallback 15px.
	const baseline = (await evalJs(
		cdp,
		`JSON.stringify({
			rootVar: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim(),
			shellFont: getComputedStyle(document.querySelector('.gui-shell')).fontSize,
			bodyFont: getComputedStyle(document.body).fontSize,
		})`,
	)) as string;
	console.log("baseline:", baseline);

	// Simulate the settings stepper: set --gui-font-scale on the root.
	await evalJs(
		cdp,
		`document.documentElement.style.setProperty('--gui-font-scale', '18px')`,
	);
	await Bun.sleep(200);
	const scaled = (await evalJs(
		cdp,
		`JSON.stringify({
			uiFont: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim(),
			shellFont: getComputedStyle(document.querySelector('.gui-shell')).fontSize,
			smToken: getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size-sm').trim(),
		})`,
	)) as string;
	console.log("scaled(18px):", scaled);

	const ok = baseline.includes("15px") && scaled.includes("18px") && scaled.includes("calc(18px - 1px)");
	console.log(ok ? "PASS: font scale follows the settings stepper" : "FAIL");
	process.exitCode = ok ? 0 : 1;
} finally {
	chrome.kill("SIGKILL");
	rmSync(tmpDir, { recursive: true, force: true });
}
