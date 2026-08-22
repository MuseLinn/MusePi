/**
 * Electron shell bridge (thin, typed) for the renderer: native directory
 * picker for ZCode-style "打开文件夹" project add. The daemon bridge lives in
 * app.tsx (boot chain); this is only the dialog.
 */

export interface ElectronAPI {
	/** Node platform of the desktop shell ("" outside Electron). */
	platform?: string;
	probeDaemonPort(): Promise<number | null>;
	startDaemon(port: number): Promise<void>;
	restartDaemon(port: number): Promise<number>;
	openDirectory(): Promise<string | null>;
	copyText(text: string): Promise<boolean>;
	openMiniChat(): Promise<boolean>;
	openWith(app: string, path: string): Promise<boolean>;
	listOpenInApps(): Promise<{ apps: OpenInApp[] }>;
	openExternal(url: string): Promise<boolean>;
	readFileDataUrl(filePath: string): Promise<{ dataUrl?: string; error?: string }>;
	/** OTA probe (updater.cjs manifest compare); null result = disabled. */
	checkUpdates(): Promise<UpdateCheckResult | null>;
	/** Startup auto-check notice; returns the unsubscribe function. */
	onUpdateAvailable(cb: (result: UpdateCheckResult) => void): () => void;
}

/** An app the current folder can be opened with (openchamber open-in). */
export interface OpenInApp {
	id: string;
	label: string;
	appName: string;
	/** base64 PNG data URL of the app's real icon (empty when unavailable). */
	iconDataUrl: string;
}

/** Result of an update check (updater.cjs → renderer contract). */
export interface UpdateCheckResult {
	enabled?: boolean;
	newer?: boolean;
	current?: string;
	latest?: string;
	/** Direct download URL from the release manifest (may be empty). */
	url?: string;
	notes?: string | null;
	error?: string;
	reason?: string;
}

export function isElectron(): boolean {
	return typeof window !== "undefined" && "electronAPI" in window;
}

/** Desktop shell platform ("darwin" | "win32" | "linux"), or "" when
 *  running outside Electron (plain browser / web build). */
export function shellPlatform(): string {
	if (!isElectron()) return "";
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	return (electronAPI?.platform ?? "").toLowerCase();
}

/** Native folder picker; null when canceled or running in a browser. */
export async function pickDirectory(): Promise<string | null> {
	if (!isElectron()) return null;
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	try {
		return await electronAPI.openDirectory();
	} catch {
		return null;
	}
}

/**
 * Restart the daemon (instance menu 重启 daemon): the Electron main kills
 * the current listener and spawns a fresh `musepi serve` from the CURRENT
 * code. Resolves the new port once the listener is up. A GUI relaunch
 * alone never refreshes the daemon (it is detached and reused by design).
 */
export async function restartDaemon(port: number): Promise<number | null> {
	if (!isElectron()) return null;
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	try {
		return await electronAPI.restartDaemon(port);
	} catch {
		return null;
	}
}

/** Project name derived from a folder path (basename). */
export function projectName(path: string): string {
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

/** Clipboard write (openchamber copy-path); browser fallback via execCommand. */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (isElectron()) {
		const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
		try {
			return await electronAPI.copyText(text);
		} catch {
			// fall through to the DOM path
		}
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

/** Picture-in-picture mini chat window (openchamber mini chat). */
export async function openMiniChat(): Promise<boolean> {
	if (!isElectron()) return false;
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	try {
		return await electronAPI.openMiniChat();
	} catch {
		return false;
	}
}

/**
 * Open a URL in the default browser (project-actions preview parity).
 * Electron: shell.openExternal; browser fallback: window.open.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
	if (isElectron()) {
		const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
		try {
			return await electronAPI.openExternal(url);
		} catch {
			// fall through to window.open
		}
	}
	window.open(url, "_blank", "noopener");
	return true;
}
/** Manual check from settings (GeneralSection 检查更新). */
export function checkAppUpdates(): Promise<UpdateCheckResult | null> {
	if (!isElectron()) return Promise.resolve(null);
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	return electronAPI.checkUpdates();
}

/**
 * Subscribe to the launch auto-check notice (main.cjs pushes
 * "update-available" ~12s after boot). Outside Electron this is a no-op
 * subscription so useEffect can return it directly.
 */
export function onUpdateAvailable(cb: (result: UpdateCheckResult) => void): () => void {
	if (!isElectron()) return () => {};
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	return electronAPI.onUpdateAvailable(cb);
}

/** Open a directory with a specific app (Finder, VS Code, …). */
export async function openWith(app: string, dir: string): Promise<boolean> {
	if (!isElectron() || !dir) return false;
	const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
	try {
		return await electronAPI.openWith(app, dir);
	} catch {
		return false;
	}
}

/**
 * Installed apps for the open-in capsule (openchamber openInAppsStore
 * parity). Electron: real icons via app.getFileIcon. Browser fallback: the
 * known list without icons, so the capsule still renders.
 */
export async function listOpenInApps(): Promise<OpenInApp[]> {
	if (isElectron()) {
		const { electronAPI } = window as unknown as { electronAPI: ElectronAPI };
		try {
			return (await electronAPI.listOpenInApps()).apps;
		} catch {
			// fall through to the static list
		}
	}
	return [
		{ id: "finder", label: "Finder", appName: "Finder", iconDataUrl: "" },
		{ id: "terminal", label: "Terminal", appName: "Terminal", iconDataUrl: "" },
		{ id: "vscode", label: "Visual Studio Code", appName: "Visual Studio Code", iconDataUrl: "" },
		{ id: "cursor", label: "Cursor", appName: "Cursor", iconDataUrl: "" },
		{ id: "iterm", label: "iTerm", appName: "iTerm", iconDataUrl: "" },
	];
}
