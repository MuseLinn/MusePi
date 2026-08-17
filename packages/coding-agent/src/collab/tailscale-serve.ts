/**
 * Tailscale Serve integration: expose the LAN relay over the tailnet's
 * MagicDNS name with a real Let's Encrypt certificate, so tailnet devices
 * (phones on cellular, other machines) get a browser link with NO cert
 * warning — the only way to kill the self-signed warning for LAN sharing.
 *
 * Degrades to null whenever serve is unavailable (no CLI, tailscaled down,
 * HTTPS is a paid Tailscale feature, or a user-managed serve config already
 * exists — serve config is a single proxy tree and `serve --bg` would
 * replace it).
 */
import { spawn } from "node:child_process";

// <machine>.<tailnet>.ts.net — the tailnet label is a second dotted segment.
const TS_NET_URL_RE = /https:\/\/[a-z0-9.-]+\.ts\.net/;

export interface TailscaleServeHandle {
	/** https://<machine>.<tailnet>.ts.net */
	baseUrl: string;
	stop: () => Promise<void>;
}

export interface TailscaleServeOptions {
	/** Local plaintext relay port the serve proxy points at. */
	port: number;
	onStatus?: (line: string) => void;
	/** tailscale binary; defaults to "tailscale" resolved via PATH. */
	binary?: string;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runTailscale(binary: string, args: string[]): Promise<RunResult> {
	return new Promise(resolve => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", c => (stdout += c));
		child.stderr.on("data", c => (stderr += c));
		child.on("error", err => resolve({ code: null, stdout, stderr: err.message }));
		child.on("exit", code => resolve({ code, stdout, stderr }));
	});
}

/**
 * Start `tailscale serve --bg http://localhost:<port>` and return the
 * tailnet base URL, or null when serve cannot be used (see header). The
 * caller owns `stop()` (resets the serve config it created).
 */
export async function startTailscaleServe(options: TailscaleServeOptions): Promise<TailscaleServeHandle | null> {
	const onStatus = options.onStatus;
	const binary = options.binary ?? "tailscale";

	// Never clobber a user-managed serve config.
	const existing = await runTailscale(binary, ["serve", "status", "--json"]);
	if (existing.code !== 0) return null; // no CLI or tailscaled down
	try {
		const parsed: unknown = JSON.parse(existing.stdout);
		if (parsed && typeof parsed === "object" && Object.keys(parsed as object).length > 0) {
			return null; // user already serves something
		}
	} catch {
		return null;
	}

	onStatus?.(`tunnel: starting tailscale serve → ws://localhost:${options.port}`);
	const started = await runTailscale(binary, ["serve", "--bg", `http://localhost:${options.port}`]);
	const baseUrl = TS_NET_URL_RE.exec(started.stdout)?.[0] ?? null;
	if (started.code !== 0 || !baseUrl) {
		// HTTPS is a paid Tailscale feature; degrade to the self-signed link.
		const detail = started.stderr.trim().split("\n").at(-1) ?? "unknown error";
		onStatus?.(`tunnel: tailscale serve unavailable (${detail}) — using the self-signed LAN link`);
		return null;
	}
	onStatus?.(`tunnel: tailnet URL ${baseUrl} (no cert warning)`);
	return {
		baseUrl,
		stop: async () => {
			await runTailscale(binary, ["serve", "reset"]);
		},
	};
}
