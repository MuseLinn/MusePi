/**
 * WSL detection for the connection manager.
 *
 * The daemon inside a WSL2 distribution listens on the distribution's own
 * loopback; reaching it from the Windows shell goes through WSL's localhost
 * forwarding. Two facts drive everything here and must not be papered over:
 *
 *  1. Localhost forwarding is not universally on. `.wslconfig` can disable it
 *     and older setups predate it, so the manager says so instead of assuming
 *     the endpoint answers.
 *  2. The renderer cannot run `wsl.exe` itself: the shell is sandboxed
 *     (`sandbox: true`, `nodeIntegration: false`) and the preload exposes no
 *     command runner. Detection therefore goes through one injectable seam —
 *     {@link WslRunner} — so the parser is fully testable today and a shell
 *     bridge can be wired to the same seam later without touching the UI.
 *
 * The distinction between "no distributions" and "could not ask" is the same
 * one bitfun's `useWslSupport` makes (supported / unsupported / unavailable):
 * an empty list from a successful probe is a real answer, a failed probe is
 * not. Collapsing them would make a broken bridge look like a Windows install
 * with no WSL.
 */

/** A distribution as `wsl.exe -l -q` reports it. */
export interface WslDistro {
	name: string;
	/** True for the distribution the bare `wsl` command would start. */
	isDefault: boolean;
}

export type WslDetection =
	| { status: "ok"; distros: WslDistro[] }
	| { status: "unsupported" }
	| { status: "unavailable"; error: string };

/**
 * Runs `wsl.exe -l -q` and resolves its stdout.
 *
 * Returning `null` means "this host has no way to ask" (not Windows, or no
 * bridge) — different from a rejected promise, which is a probe that ran and
 * failed.
 */
export type WslRunner = () => Promise<string | null>;

const DEFAULT_MARK = "(Default)";

/**
 * Parse `wsl.exe -l -q` output.
 *
 * Real-world output is UTF-16LE on many Windows installs (the console still
 * prints a blank line between characters when the byte stream is decoded as
 * UTF-8), so this strips interleaved NULs first. Windows CRLF, a leading BOM,
 * blank lines, and wrapped `*`/`(Default)` markers from `-l -v` style output
 * are all tolerated; a distribution name is never synthesized from them.
 */
export function parseWslDistroList(raw: string): WslDistro[] {
	// UTF-16 decoded as Latin-1 leaves a NUL between every real character.
	const normalized = raw.includes("\u0000") ? raw.replace(/\u0000/g, "") : raw;
	const lines = normalized.replace(/^\uFEFF/, "").split(/\r?\n/);
	const distros: WslDistro[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		let name = line.trim();
		if (!name) continue;
		let isDefault = false;
		if (name.startsWith("*")) {
			isDefault = true;
			name = name.slice(1).trim();
		}
		if (name.toLowerCase().endsWith(DEFAULT_MARK)) {
			isDefault = true;
			name = name.slice(0, name.toLowerCase().lastIndexOf(DEFAULT_MARK)).trim();
		}
		// `wsl.exe -l -q` prints names only; anything that still looks like a
		// header row ("NAME  STATE  VERSION") is output this parser cannot
		// trust, and a fake distribution named NAME would be worse than none.
		if (!name || /^(name|名称)\b/i.test(name)) continue;
		// `-l -v` output carries columns after the name. Names cannot contain
		// whitespace, so the first run is the name and the rest is state.
		if (/\s/.test(name)) name = name.split(/\s+/, 1)[0] ?? name;
		if (seen.has(name)) continue;
		seen.add(name);
		distros.push({ name, isDefault });
	}
	// Without an explicit marker, WSL's own default is the first entry.
	if (distros.length > 0 && !distros.some(distro => distro.isDefault)) {
		const [first] = distros;
		if (first) distros[0] = { ...first, isDefault: true };
	}
	return distros;
}

/** Detect once, reporting why when the probe could not run. */
export async function detectWsl(run: WslRunner): Promise<WslDetection> {
	let output: string | null;
	try {
		output = await run();
	} catch (err) {
		return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
	}
	if (output === null) return { status: "unsupported" };
	if (output.trim() === "") return { status: "ok", distros: [] };
	return { status: "ok", distros: parseWslDistroList(output) };
}

/**
 * The shell's default runner.
 *
 * `window.musepiShell.listWslDistributions` is the documented seam: a preload
 * bridge that spawns `wsl.exe -l -q` and returns its stdout. It does not exist
 * yet, so the default resolves `null` (unsupported) rather than throwing —
 * the manager then offers the manual form and says detection is unavailable
 * on this build instead of guessing at a distro list.
 */
export const defaultWslRunner: WslRunner = async () => {
	const bridge = (
		window as unknown as {
			musepiShell?: { listWslDistributions?(): Promise<string | null> };
		}
	).musepiShell;
	if (!bridge?.listWslDistributions) return null;
	try {
		return await bridge.listWslDistributions();
	} catch (err) {
		throw err instanceof Error ? err : new Error(String(err));
	}
};

/** Is detection even meaningful on this shell? */
export function isWindowsShell(platform: string | undefined): boolean {
	return platform === "win32";
}
