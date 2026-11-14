/**
 * Installed-application discovery and launch for the `desktop` API.
 *
 * The native desktop session owns windows, not launch targets, so this module
 * reads the platform's own catalogue: Start Menu shortcuts on Windows,
 * `*.app` bundles on macOS, and `.desktop` entries on Linux. Launching reuses
 * the OS handler for the resolved path (`start`, `open`, `xdg-open`) rather
 * than spawning the executable directly, which keeps shortcuts, app bundles
 * and `.desktop` files working uniformly.
 *
 * All filesystem roots are injectable so the parsing and matching rules are
 * testable without a real desktop.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface DesktopApp {
	/** Human-facing name, e.g. "Notion" or "Visual Studio Code". */
	name: string;
	/** Absolute path (shortcut, bundle or desktop entry). */
	id: string;
	kind: "shortcut" | "bundle" | "desktop-entry";
	/** Set when a window of this application is on screen. */
	running?: boolean;
	/** Owning process of that window, when the platform exposes it. */
	pid?: number;
}

export interface AppRoots {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
}

const MAX_APPS = 500;
const MAX_DEPTH = 4;

function windowsRoots(roots: AppRoots): string[] {
	const programData = roots.env.ProgramData ?? roots.env.PROGRAMDATA;
	const appData = roots.env.APPDATA;
	const list: string[] = [];
	if (programData) list.push(path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"));
	if (appData) list.push(path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"));
	return list;
}

async function walkShortcuts(root: string, depth = 0): Promise<DesktopApp[]> {
	if (depth > MAX_DEPTH) return [];
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: DesktopApp[] = [];
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await walkShortcuts(full, depth + 1)));
			continue;
		}
		if (!/\.(lnk|exe)$/i.test(entry.name)) continue;
		found.push({ name: entry.name.replace(/\.(lnk|exe)$/i, ""), id: full, kind: "shortcut" });
	}
	return found;
}

async function macApps(roots: AppRoots): Promise<DesktopApp[]> {
	const dirs = ["/Applications", "/System/Applications", path.join(roots.home, "Applications")];
	const found: DesktopApp[] = [];
	for (const dir of dirs) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
			found.push({
				name: entry.name.slice(0, -".app".length),
				id: path.join(dir, entry.name),
				kind: "bundle",
			});
		}
	}
	return found;
}

/** `Name=` from a freedesktop entry, ignoring localized `Name[xx]=` keys. */
export function desktopEntryName(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const match = /^Name=(.+)$/.exec(line.trim());
		if (match) return match[1]!.trim();
	}
	return null;
}

async function linuxApps(roots: AppRoots): Promise<DesktopApp[]> {
	const dirs = [
		"/usr/share/applications",
		"/usr/local/share/applications",
		path.join(roots.home, ".local", "share", "applications"),
	];
	const found: DesktopApp[] = [];
	for (const dir of dirs) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
			const id = path.join(dir, entry.name);
			let name: string | null = null;
			try {
				name = desktopEntryName(await fs.readFile(id, "utf8"));
			} catch {
				name = null;
			}
			found.push({ name: name ?? entry.name.replace(/\.desktop$/, ""), id, kind: "desktop-entry" });
		}
	}
	return found;
}

/** Every launch target the platform advertises, deduplicated by path and
 *  sorted by name. Missing roots are normal (a machine may have none). */
export async function listInstalledApps(roots: AppRoots): Promise<DesktopApp[]> {
	const apps =
		roots.platform === "win32"
			? (await Promise.all(windowsRoots(roots).map(root => walkShortcuts(root)))).flat()
			: roots.platform === "darwin"
				? await macApps(roots)
				: roots.platform === "linux"
					? await linuxApps(roots)
					: [];
	const seen = new Set<string>();
	const unique: DesktopApp[] = [];
	for (const app of apps) {
		if (seen.has(app.id)) continue;
		seen.add(app.id);
		unique.push(app);
	}
	unique.sort((left, right) => left.name.localeCompare(right.name));
	return unique.slice(0, MAX_APPS);
}

/** `listInstalledApps` with the host's real roots. */
export function hostInstalledApps(): Promise<DesktopApp[]> {
	return listInstalledApps({ platform: process.platform, env: process.env, home: os.homedir() });
}

/**
 * Resolve one launch target: an exact id, an exact name, or a unique
 * case-insensitive name. Ambiguity is an error that lists the candidates —
 * launching the wrong app is worse than asking for a narrower name.
 */
export function resolveApp(apps: readonly DesktopApp[], query: string): DesktopApp {
	const wanted = query.trim();
	if (wanted.length === 0) throw new Error("launch target is empty");
	const byId = apps.find(app => app.id === wanted);
	if (byId) return byId;
	const exact = apps.filter(app => app.name === wanted);
	if (exact.length === 1) return exact[0]!;
	const loose = apps.filter(app => app.name.toLowerCase() === wanted.toLowerCase());
	const matches = exact.length > 1 ? exact : loose;
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) {
		const prefix = apps.filter(app => app.name.toLowerCase().startsWith(wanted.toLowerCase())).slice(0, 8);
		const hint = prefix.length > 0 ? `\ncandidates: ${prefix.map(app => app.name).join(", ")}` : "";
		throw new Error(`no installed app matches ${JSON.stringify(wanted)}${hint}`);
	}
	throw new Error(
		`multiple apps match ${JSON.stringify(wanted)}:\n${matches.map(app => `${app.name} — ${app.id}`).join("\n")}`,
	);
}

export function launchCommand(platform: NodeJS.Platform, target: string): string[] {
	if (platform === "win32") return ["cmd.exe", "/c", "start", "", target];
	if (platform === "darwin") return ["open", target];
	return ["xdg-open", target];
}

/** A window the desktop session can see, reduced to what app matching needs. */
export interface RunningWindow {
	app: string;
	pid?: number;
}

const normalizeApp = (value: string): string => value.toLowerCase().replace(/[\s._-]+/g, "");

/**
 * Mark catalogue entries whose application currently has a window. Window
 * ownership comes from the OS, so this is observed state, not a guess from a
 * process list; an app that runs without a window stays `running: false`.
 */
export function annotateRunning(apps: readonly DesktopApp[], windows: readonly RunningWindow[]): DesktopApp[] {
	// `null` records "running, pid unknown"; `has` separates that from absent.
	const byApp = new Map<string, number | null>();
	for (const window of windows) {
		const key = normalizeApp(window.app);
		if (key.length > 0 && !byApp.has(key)) byApp.set(key, window.pid ?? null);
	}
	return apps.map(app => {
		const key = normalizeApp(app.name);
		if (!byApp.has(key)) return app;
		const pid = byApp.get(key) ?? undefined;
		return { ...app, running: true, ...(pid !== undefined ? { pid } : {}) };
	});
}
