/**
 * Daemon-side browser RPCs for the GUI: expose the SHARED automation
 * Chromium (the same instance the agent drives — per-project broker
 * supervised) to the settings panel and the right-pane BrowserPane.
 *
 * - browser.endpoint    ensure the shared Chromium and return its CDP ws
 *                       endpoint + stable profile dir (no agent involved)
 * - browser.tabs        list live page targets (title/url)
 * - browser.screenshot  JPEG capture of one tab (attach → capture → detach)
 * - browser.extensions  list extensions present in the shared profile
 * - browser.relayInstall  write the MusePi Browser Relay extension files
 *                       (chrome.debugger bridge into the user's own Chrome)
 *
 * The CDP client here is intentionally minimal (one request per
 * connection): these are low-frequency GUI actions, not the hot tool path.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayDir } from "@musepi/pi-utils";
import { DEFAULT_RELAY_PORT } from "../cli/browser-relay-cli";
import type { Settings } from "../config/settings";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { ensureSharedBrowser } from "../tools/browser/shared-daemon";

export interface BrowserTabInfo {
	targetId: string;
	title: string;
	url: string;
}

export interface BrowserExtensionInfo {
	id: string;
	name: string;
	version: string;
}

interface CdpConn {
	ws: WebSocket;
	nextId: number;
	pending: Map<number, { resolve(value: unknown): void; reject(err: Error): void }>;
}

/** Open one CDP connection (attach sessionIds are connection-scoped, so
 *  attach → enable → capture must share a single socket). */
async function cdpConnect(wsUrl: string, timeoutMs = 8_000): Promise<CdpConn> {
	const conn: CdpConn = { ws: null as unknown as WebSocket, nextId: 1, pending: new Map() };
	const opened = Promise.withResolvers<void>();
	let settled = false;
	const fail = (err: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opened.reject(err);
	};
	const timer = setTimeout(() => fail(new Error(`CDP connect timed out: ${wsUrl}`)), timeoutMs);
	try {
		conn.ws = new WebSocket(wsUrl);
	} catch (err) {
		fail(err instanceof Error ? err : new Error(String(err)));
	}
	conn.ws.addEventListener("open", () => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opened.resolve();
	});
	conn.ws.addEventListener("message", ev => {
		try {
			const data = JSON.parse(String(ev.data)) as {
				id?: number;
				result?: unknown;
				error?: { message?: string };
			};
			const p = data.id !== undefined ? conn.pending.get(data.id) : undefined;
			if (!p) return;
			conn.pending.delete(data.id!);
			if (data.error) p.reject(new Error(data.error.message ?? "CDP error"));
			else p.resolve(data.result);
		} catch {
			// malformed frame — ignore
		}
	});
	conn.ws.addEventListener("error", () => {
		for (const p of conn.pending.values()) p.reject(new Error("CDP connection error"));
		conn.pending.clear();
		fail(new Error(`CDP connection failed: ${wsUrl}`));
	});
	await opened.promise;
	return conn;
}

function cdpClose(conn: CdpConn): void {
	try {
		conn.ws.close();
	} catch {
		// already closed
	}
	for (const p of conn.pending.values()) p.reject(new Error("CDP connection closed"));
	conn.pending.clear();
}

/** One request on an existing connection. */
function cdpCall(
	conn: CdpConn,
	method: string,
	params: Record<string, unknown> | undefined,
	sessionId?: string,
	timeoutMs = 8_000,
): Promise<unknown> {
	const id = conn.nextId++;
	const call = Promise.withResolvers<unknown>();
	const timer = setTimeout(() => {
		conn.pending.delete(id);
		call.reject(new Error(`CDP ${method} timed out`));
	}, timeoutMs);
	conn.pending.set(id, {
		resolve: v => {
			clearTimeout(timer);
			call.resolve(v);
		},
		reject: err => {
			clearTimeout(timer);
			call.reject(err);
		},
	});
	conn.ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
	return call.promise;
}

/** One-shot CDP request over a fresh connection (no session affinity). */
async function cdpRequest(
	wsUrl: string,
	method: string,
	params: Record<string, unknown> | undefined,
	sessionId?: string,
	timeoutMs = 8_000,
): Promise<unknown> {
	const conn = await cdpConnect(wsUrl, timeoutMs);
	try {
		return await cdpCall(conn, method, params, sessionId, timeoutMs);
	} finally {
		cdpClose(conn);
	}
}

/** Resolve the shared-browser endpoint honoring the headless setting. */
async function sharedBrowserEndpoint(
	settings: Settings,
	projectDir: string,
): Promise<{ wsEndpoint: string; profileDir: string; headless: boolean } | null> {
	const headless = (settings.get("browser.headless") as boolean | undefined) ?? true;
	const shared = await ensureSharedBrowser({ projectDir, headless });
	if (!shared) return null;
	const { sharedBrowserDaemonName } = await import("../tools/browser/shared-daemon");
	const profileDir = path.join(
		// The broker runtime dir mirrors ensureSharedBrowser's profile layout.
		// resolveSharedBrowserLaunchSpec names it <daemonName>.profile — reuse
		// the same derivation the tool path uses.
		await daemonRuntimeDirFor(shared.projectDir),
		`${sharedBrowserDaemonName(headless)}.profile`,
	);
	return { wsEndpoint: shared.wsEndpoint, profileDir, headless };
}

async function daemonRuntimeDirFor(projectDir: string): Promise<string> {
	// Lazy import keeps the heavy launch machinery out of the server's
	// startup path.
	const { daemonRuntimeDir } = await import("../launch/paths");
	return daemonRuntimeDir(projectDir);
}

export async function browserEndpoint(
	settings: Settings,
	projectDir: string,
): Promise<{ wsEndpoint: string; profileDir: string; headless: boolean } | null> {
	return sharedBrowserEndpoint(settings, projectDir);
}

export async function browserTabs(
	settings: Settings,
	projectDir: string,
): Promise<{ tabs: BrowserTabInfo[]; wsEndpoint: string | null }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { tabs: [], wsEndpoint: null };
	try {
		const res = (await cdpRequest(ep.wsEndpoint, "Target.getTargets", undefined)) as {
			targetInfos?: { targetId: string; title: string; url: string; type: string }[];
		};
		const tabs = (res.targetInfos ?? [])
			.filter(t => t.type === "page" && t.url && !t.url.startsWith("devtools://"))
			.map(t => ({ targetId: t.targetId, title: t.title || t.url, url: t.url }));
		return { tabs, wsEndpoint: ep.wsEndpoint };
	} catch {
		return { tabs: [], wsEndpoint: ep.wsEndpoint };
	}
}

export async function browserScreenshot(
	settings: Settings,
	projectDir: string,
	targetId: string,
): Promise<{ base64?: string; error?: string }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { error: "shared browser unavailable" };
	// Attach sessionIds are CONNECTION-scoped — attach/enable/capture must
	// share one socket (a fresh connection per request would reject the
	// session with "Session with given id not found").
	let conn: CdpConn | null = null;
	try {
		conn = await cdpConnect(ep.wsEndpoint);
		const attach = (await cdpCall(conn, "Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId?: string };
		if (!attach.sessionId) return { error: "attach failed" };
		try {
			await cdpCall(conn, "Page.enable", undefined, attach.sessionId);
			const shot = (await cdpCall(
				conn,
				"Page.captureScreenshot",
				{ format: "jpeg", quality: 45 },
				attach.sessionId,
			)) as { data?: string };
			return shot.data ? { base64: shot.data } : { error: "capture returned no data" };
		} finally {
			await cdpCall(conn, "Target.detachFromTarget", { targetId }).catch(() => {});
		}
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (conn) cdpClose(conn);
	}
}

/** Scan the shared profile's Extensions dir for installed extensions. */
export async function browserExtensions(
	settings: Settings,
	projectDir: string,
): Promise<{ extensions: BrowserExtensionInfo[]; profileDir: string | null }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { extensions: [], profileDir: null };
	const extensionsDir = path.join(ep.profileDir, "Extensions");
	const out: BrowserExtensionInfo[] = [];
	try {
		const entries = await fsReaddir(extensionsDir);
		for (const extId of entries) {
			const extRoot = path.join(extensionsDir, extId);
			const versions = await fsReaddir(extRoot).catch(() => [] as string[]);
			const version = versions
				.filter(v => v !== "_metadata")
				.sort()
				.at(-1);
			if (!version) continue;
			try {
				const manifest = JSON.parse(await fsReadFile(path.join(extRoot, version, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				out.push({
					id: extId,
					name: manifest.name ?? extId,
					version: manifest.version ?? version,
				});
			} catch {
				out.push({ id: extId, name: extId, version });
			}
		}
	} catch {
		// no Extensions dir yet — nothing installed
	}
	return { extensions: out, profileDir: ep.profileDir };
}

/** Write the MusePi Browser Relay extension files (chrome.debugger bridge)
 *  and return the install dir — same output as `musepi browser-relay install`. */
export async function browserRelayInstall(): Promise<{ dir: string; ok: boolean }> {
	const { runBrowserRelayCommand } = await import("../cli/browser-relay-cli");
	const dir = path.join(getBrowserRelayDir(), "extension");
	await runBrowserRelayCommand({ action: "install", port: DEFAULT_RELAY_PORT, dir });
	return { dir, ok: true };
}

/** Relay 扩展三层状态: 文件是否写出 + server 是否在跑 + 扩展是否已连上
 *  (200 = 扩展已连接并握手、503 = server 在跑但扩展未加载)。UI 据此区分
 *  「未安装 / 已安装未加载 / 已连接」。 */
export async function browserRelayStatus(): Promise<{
	extensionDir: string;
	installed: boolean;
	serving: boolean;
	connected: boolean;
}> {
	const extensionDir = path.join(getBrowserRelayDir(), "extension");
	const installed = await Bun.file(path.join(extensionDir, "manifest.json")).exists();
	let serving = false;
	let connected = false;
	try {
		const res = await fetch(`${DEFAULT_RELAY_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
		if (res.ok) {
			serving = true;
			connected = true;
		} else if (res.status === 503) {
			serving = true;
		}
		await res.body?.cancel();
	} catch {
		// relay 未运行
	}
	return { extensionDir, installed, serving, connected };
}

/** 卸载 relay 扩展: 删除写出的扩展目录(对称于 relayInstall)。 */
export async function browserRelayUninstall(): Promise<{ ok: boolean; dir: string }> {
	const dir = path.join(getBrowserRelayDir(), "extension");
	await fsp.rm(dir, { recursive: true, force: true });
	return { ok: true, dir };
}

async function fsReaddir(dir: string): Promise<string[]> {
	return fsp.readdir(dir);
}

async function fsReadFile(file: string, enc: "utf8"): Promise<string> {
	return fsp.readFile(file, enc);
}

/** Locate the Chrome user-data profile that was used most recently
 *  (macOS layout; Linux/Windows fall back to the platform default dir). */
function chromeProfiles(): string[] {
	const home = process.env.HOME ?? "";
	const base =
		process.platform === "darwin"
			? `${home}/Library/Application Support/Google/Chrome`
			: process.platform === "win32"
				? `${process.env.LOCALAPPDATA ?? home}\\Google\\Chrome\\User Data`
				: `${home}/.config/google-chrome`;
	// "Default" is the primary profile; numbered Profile N are secondary.
	const out: string[] = [];
	try {
		const entries = fsReaddirSync(base);
		if (entries.includes("Default")) out.push(`${base}/Default`);
		for (const name of entries.filter(n => /^Profile \d+$/.test(n)).sort()) out.push(`${base}/${name}`);
	} catch {
		// no Chrome profile dir
	}
	return out;
}

function fsReaddirSync(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function fsCopyFileSync(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		fs.copyFileSync(src, dst);
	} catch {
		// locked or missing — best effort
	}
}

/** One-time import of Cookies + LocalStorage from the most recent Chrome
 *  profile into the shared browser profile (zcode 浏览器数据 parity).
 *  Copies the SQLite cookie DB and the Local Storage leveldb tree. */
export async function browserImportChrome(
	settings: Settings,
	projectDir: string,
): Promise<{ ok: boolean; importedFrom?: string; error?: string }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { ok: false, error: "shared browser unavailable" };
	const profiles = chromeProfiles();
	if (profiles.length === 0) return { ok: false, error: "no Chrome profile found" };
	const src = profiles[0]!;
	const dst = ep.profileDir;
	fsCopyFileSync(`${src}/Cookies`, `${dst}/Cookies`);
	fsCopyFileSync(`${src}/Network/Cookies`, `${dst}/Network/Cookies`);
	const lsSrc = `${src}/Local Storage/leveldb`;
	const lsDst = `${dst}/Local Storage/leveldb`;
	for (const file of fsReaddirSync(lsSrc)) {
		fsCopyFileSync(`${lsSrc}/${file}`, `${lsDst}/${file}`);
	}
	return { ok: true, importedFrom: src };
}

/** Clear HTTP cache / CacheStorage / Service Worker (keep cookies). */
export async function browserClearCache(
	settings: Settings,
	projectDir: string,
): Promise<{ ok: boolean; error?: string }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { ok: false, error: "shared browser unavailable" };
	try {
		const conn = await cdpConnect(ep.wsEndpoint);
		try {
			await cdpCall(conn, "Network.clearBrowserCache", undefined).catch(() => {});
		} finally {
			cdpClose(conn);
		}
	} catch {
		// CDP unreachable — the directory wipe below still clears the disk cache
	}
	for (const sub of ["Cache", "Code Cache", "GPUCache", "Service Worker", "CacheStorage"]) {
		await fsp.rm(path.join(ep.profileDir, sub), { recursive: true, force: true }).catch(() => {});
	}
	return { ok: true };
}

/** Clear cookies + site data + cache (irreversible). */
export async function browserClearAll(
	settings: Settings,
	projectDir: string,
): Promise<{ ok: boolean; error?: string }> {
	const ep = await sharedBrowserEndpoint(settings, projectDir);
	if (!ep) return { ok: false, error: "shared browser unavailable" };
	try {
		const conn = await cdpConnect(ep.wsEndpoint);
		try {
			await cdpCall(conn, "Network.clearBrowserCache", undefined).catch(() => {});
			const targets = (await cdpCall(conn, "Target.getTargets", undefined)) as {
				targetInfos?: { targetId: string; type: string }[];
			};
			for (const t of targets.targetInfos ?? []) {
				if (t.type !== "page") continue;
				const attach = (await cdpCall(conn, "Target.attachToTarget", {
					targetId: t.targetId,
					flatten: true,
				})) as { sessionId?: string };
				if (!attach.sessionId) continue;
				try {
					await cdpCall(
						conn,
						"Storage.clearDataForOrigin",
						{ origin: "*", storageTypes: "all" },
						attach.sessionId,
					).catch(() => {});
				} finally {
					await cdpCall(conn, "Target.detachFromTarget", { targetId: t.targetId }).catch(() => {});
				}
			}
		} finally {
			cdpClose(conn);
		}
	} catch {
		// directory wipe below still clears disk state
	}
	for (const sub of [
		"Cache",
		"Code Cache",
		"GPUCache",
		"Service Worker",
		"CacheStorage",
		"Cookies",
		"Local Storage",
		"IndexedDB",
		"Session Storage",
	]) {
		await fsp.rm(path.join(ep.profileDir, sub), { recursive: true, force: true }).catch(() => {});
	}
	return { ok: true };
}
