/**
 * Managed CLI connector runtime.
 *
 * A CLI connector installs one package into an isolated prefix under the agent
 * directory, verifies a minimum version, then relies on the package's own
 * `auth`/`status` subcommands. Nothing is installed globally and catalog
 * command strings are tokenized and spawned as argv. On Windows a bare name
 * resolves through PATH/PATHEXT, and `.cmd`/`.bat` shims — which is what npm
 * and its installed CLIs actually produce — run through `cmd.exe`, because
 * spawn cannot start a batch file directly.
 *
 * The catalog is untrusted input, so the installer command must start with a
 * known package manager; auth/status/logout commands are shown to the user in
 * the approval panel before they run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import type { ConnectorCliSpec, ConnectorPlatform, ConnectorPlatformCommand } from "./types";

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const AUTH_OUTPUT_WINDOW_MS = 4_000;
const INSTALLERS = new Set([
	"npm",
	"npm.cmd",
	"pnpm",
	"pnpm.cmd",
	"yarn",
	"yarn.cmd",
	"bun",
	"bun.exe",
	"uv",
	"uv.exe",
]);

export interface CliRunResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface CliVersionResult {
	installed: boolean;
	version?: string;
	needsUpgrade: boolean;
	error?: string;
}

export interface CliAuthStart {
	process: Bun.Subprocess<"ignore", "pipe", "pipe">;
	authorizationUrl?: string;
	userCode?: string;
	exitCode: number | null;
}

export interface CliStatusResult {
	loggedIn: boolean;
	raw: string;
}

export function resolveCliCommand(
	value: string | ConnectorPlatformCommand | undefined,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return value;
	return value[platform as ConnectorPlatform];
}

/** Split a command line into argv without invoking a shell. */
export function tokenizeCommand(line: string): string[] {
	const argv: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (char === "\\" && quote !== "'") {
			const next = line[index + 1];
			// Outside quotes a backslash escapes anything; inside double quotes
			// it only escapes a quote or another backslash, so Windows paths
			// such as "C:\Program Files\node.exe" survive intact.
			if (!quote || next === '"' || next === "\\") {
				if (next !== undefined) {
					current += next;
					index += 1;
					continue;
				}
			}
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				argv.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) argv.push(current);
	return argv;
}

function cliPaths(): { root: string; prefix: string; cache: string; pathDirs: string[] } {
	const root = path.join(getAgentDir(), "cli-connectors");
	const prefix = path.join(root, "packages");
	const cache = path.join(root, "cache");
	const pathDirs = [path.join(prefix, "bin"), prefix, process.env.PATH ?? ""].filter(Boolean) as string[];
	return { root, prefix, cache, pathDirs };
}

/** Processes run in the agent directory, which may not exist on a fresh profile. */
function ensureAgentDir(): string {
	const dir = getAgentDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function envWithPath(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Windows treats PATH case-insensitively; keep one canonical key.
	for (const key of Object.keys(env)) {
		if (key !== "PATH" && key.toLowerCase() === "path") delete env[key];
	}
	const { pathDirs } = cliPaths();
	env.PATH = pathDirs.join(path.delimiter);
	return { ...env, ...extra };
}

const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/** Find the real file behind a bare command name on Windows. */
export function resolveWindowsProgram(name: string, searchPath: string): string | undefined {
	if (process.platform !== "win32" || !name || /[/\\]/.test(name)) return undefined;
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	for (const dir of searchPath.split(path.delimiter)) {
		if (!dir) continue;
		const base = path.join(dir, name);
		for (const candidate of [...extensions.flatMap(ext => [base + ext.toLowerCase(), base + ext]), base]) {
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// not this one
			}
		}
	}
	return undefined;
}

function quoteForCmd(value: string): string {
	return /[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export interface SpawnPlan {
	argv: string[];
	/** Windows only: pass the command line through untouched. */
	verbatim: boolean;
}

/** argv handed to spawn: bare names resolve to real files, batch shims go through cmd.exe. */
export function planSpawn(argv: string[], searchPath: string): SpawnPlan {
	if (process.platform !== "win32" || argv.length === 0) return { argv, verbatim: false };
	const program = resolveWindowsProgram(argv[0] ?? "", searchPath);
	if (!program) return { argv, verbatim: false };
	const rest = argv.slice(1);
	if (!WINDOWS_BATCH_EXTENSIONS.has(path.extname(program).toLowerCase())) {
		return { argv: [program, ...rest], verbatim: false };
	}
	// cmd /d /s /c ""program" "arg"" — the outer pair is the one /s strips.
	const line = [program, ...rest].map(quoteForCmd).join(" ");
	return {
		argv: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${line}"`],
		verbatim: true,
	};
}

async function runArgv(
	argv: string[],
	options: { timeoutMs: number; env?: Record<string, string> },
): Promise<CliRunResult> {
	if (argv.length === 0) return { ok: false, exitCode: null, stdout: "", stderr: "empty command", timedOut: false };
	const env = envWithPath(options.env);
	const plan = planSpawn(argv, env.PATH ?? "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const proc = Bun.spawn({
			cmd: plan.argv,
			windowsVerbatimArguments: plan.verbatim,
			stdout: "pipe",
			stderr: "pipe",
			env,
			cwd: ensureAgentDir(),
			signal: controller.signal,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exitCode === 0, exitCode, stdout, stderr, timedOut: false };
	} catch (error) {
		if (controller.signal.aborted) {
			return { ok: false, exitCode: null, stdout: "", stderr: "command timed out", timedOut: true };
		}
		return {
			ok: false,
			exitCode: null,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			timedOut: false,
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function runCliCommand(line: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CliRunResult> {
	return runArgv(tokenizeCommand(line), { timeoutMs });
}

function parseVersion(text: string): string | undefined {
	const match = /\b(\d+\.\d+\.\d+)\b/.exec(text);
	return match?.[1];
}

function versionAtLeast(current: string, minimum: string): boolean {
	const a = current.split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

/** Run the declared version command; absent command means "assume installed". */
export async function checkCliVersion(spec: ConnectorCliSpec): Promise<CliVersionResult> {
	const command = resolveCliCommand(spec.versionCheck?.command);
	if (!command) return { installed: true, needsUpgrade: false };
	const result = await runCliCommand(command);
	const version = parseVersion(`${result.stdout}\n${result.stderr}`);
	if (!result.ok || !version) {
		return {
			installed: false,
			needsUpgrade: false,
			error: (result.stderr || result.stdout || "version check failed").trim().slice(0, 300),
		};
	}
	const minimum = spec.versionCheck?.minVersion;
	return {
		installed: true,
		version,
		needsUpgrade: Boolean(minimum && !versionAtLeast(version, minimum)),
	};
}

/** Install the package into the isolated prefix. */
export async function installCliConnector(spec: ConnectorCliSpec): Promise<CliRunResult> {
	const command = resolveCliCommand(spec.init);
	if (!command) return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
	const argv = tokenizeCommand(command);
	const installer = path.basename(argv[0] ?? "").toLowerCase();
	if (!INSTALLERS.has(installer)) {
		throw new Error(`unsupported CLI installer: ${installer || "(empty)"}`);
	}
	const { prefix, cache } = cliPaths();
	fs.mkdirSync(prefix, { recursive: true });
	fs.mkdirSync(cache, { recursive: true });
	return runArgv(argv, {
		timeoutMs: INSTALL_TIMEOUT_MS,
		env: { npm_config_prefix: prefix, npm_config_cache: cache },
	});
}

/** Pull a URL and a device code out of auth output. */
export function parseCliAuthOutput(
	text: string,
	preferredDomain?: string,
): { authorizationUrl?: string; userCode?: string } {
	const urls = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
	const authorizationUrl = preferredDomain ? (urls.find(url => url.includes(preferredDomain)) ?? urls[0]) : urls[0];
	const codePatterns = [
		/\b(?:user[_-]?code|code)\s*[:=]\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
		/\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
	];
	let userCode: string | undefined;
	for (const pattern of codePatterns) {
		const match = pattern.exec(text);
		if (match?.[1]) {
			userCode = match[1];
			break;
		}
	}
	return { ...(authorizationUrl ? { authorizationUrl } : {}), ...(userCode ? { userCode } : {}) };
}

/** Stop a CLI process; on Windows a batch shim's children are killed with it. */
export function killCliProcess(target: { pid: number; kill(): void }): void {
	if (process.platform === "win32" && target.pid) {
		try {
			Bun.spawnSync(["taskkill", "/pid", String(target.pid), "/t", "/f"], {
				stdout: "ignore",
				stderr: "ignore",
			});
		} catch {
			// taskkill missing or the process already exited
		}
	}
	try {
		target.kill();
	} catch {
		// already gone
	}
}

/** Start `auth`, capturing the URL/device code without blocking on a long poll. */
export async function startCliAuth(spec: ConnectorCliSpec): Promise<CliAuthStart> {
	const command = resolveCliCommand(spec.auth);
	if (!command) throw new Error("connector has no auth command");
	const env = envWithPath();
	const plan = planSpawn(tokenizeCommand(command), env.PATH ?? "");
	const proc = Bun.spawn({
		cmd: plan.argv,
		windowsVerbatimArguments: plan.verbatim,
		stdout: "pipe",
		stderr: "pipe",
		env,
		cwd: ensureAgentDir(),
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + AUTH_OUTPUT_WINDOW_MS;
	while (Date.now() < deadline) {
		const chunk = await Promise.race([reader.read(), Bun.sleep(200).then(() => ({ timeout: true as const }))]);
		if ("timeout" in chunk) {
			const parsed = parseCliAuthOutput(text, spec.authUrlDomain);
			if (parsed.authorizationUrl || parsed.userCode) break;
			continue;
		}
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
		const parsed = parseCliAuthOutput(text, spec.authUrlDomain);
		if (parsed.authorizationUrl && parsed.userCode) break;
	}
	const parsed = parseCliAuthOutput(text, spec.authUrlDomain);
	return { process: proc, ...parsed, exitCode: null };
}

/** Run the status command and apply the declared success marker. */
export async function runCliStatus(spec: ConnectorCliSpec): Promise<CliStatusResult> {
	const command = resolveCliCommand(spec.status);
	if (!command) return { loggedIn: false, raw: "connector has no status command" };
	const result = await runCliCommand(command);
	const raw = `${result.stdout}\n${result.stderr}`.trim();
	const marker = spec.statusMatch ?? "Logged in";
	return { loggedIn: result.ok && raw.includes(marker), raw: raw.slice(0, 500) };
}

export async function runCliLogout(spec: ConnectorCliSpec): Promise<CliRunResult> {
	const command = resolveCliCommand(spec.unAuth);
	if (!command) return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
	return runCliCommand(command);
}
