/**
 * ngrok tunnel lifecycle for collab sharing — an alternative provider to
 * cloudflared (OpenChamber exposes the same choice).
 *
 * `ngrok http <port> --log stdout --log-format json` prints the public URL
 * as a JSON log line on stdout; we scan for it. ngrok's free tier requires a
 * one-time `ngrok config add-authtoken <TOKEN>` (see the error message).
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { TunnelHandle } from "./tunnel";

const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/;
const URL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export interface NgrokTunnelOptions {
	/** Local port the relay server listens on. */
	port: number;
	/** ngrok binary; defaults to "ngrok" resolved via PATH. */
	binary?: string;
	onStatus?: (line: string) => void;
	/** Abort while waiting for the tunnel URL; kills the child and rejects. */
	signal?: AbortSignal;
}

/** Extract the ngrok public URL from its JSON log output; null until it appears. */
export function extractNgrokUrl(output: string): string | null {
	return NGROK_URL_RE.exec(output)?.[0] ?? null;
}

/**
 * Start `ngrok http <port>` and wait for the public URL on stdout. Rejects
 * (and kills the child) if the URL does not appear within {@link URL_TIMEOUT_MS},
 * the signal aborts, or the child exits first.
 */
export async function startNgrokTunnel(options: NgrokTunnelOptions): Promise<TunnelHandle> {
	const binary = options.binary ?? "ngrok";
	const onStatus = options.onStatus;
	const { promise, resolve, reject } = Promise.withResolvers<string>();

	onStatus?.(`tunnel: starting ${binary} http ${options.port}`);
	const child = spawn(binary, ["http", String(options.port), "--log", "stdout", "--log-format", "json"], {
		stdio: ["ignore", "pipe", "pipe"],
		// Windows: the GUI-hosted daemon has no console; without this the
		// ngrok child allocates a visible conhost window on share start.
		windowsHide: true,
	});
	let output = "";
	let settled = false;
	const finish = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		fn();
	};

	const scan = (chunk: string): void => {
		output += chunk;
		const url = extractNgrokUrl(output);
		if (url) {
			finish(() => resolve(url));
			return;
		}
		const line = chunk.trim().split("\n").at(-1);
		if (line) onStatus?.(`tunnel: ${line}`);
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", scan);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", scan);

	child.on("error", err => {
		const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
		const detail = missing
			? `${binary} is not installed. Install it with \`brew install ngrok/ngrok/ngrok\` or from https://ngrok.com/download and run \`ngrok config add-authtoken <TOKEN>\` once (https://dashboard.ngrok.com/get-started/setup)`
			: `failed to start ${binary}: ${err.message}`;
		finish(() => reject(new Error(detail)));
	});
	child.on("exit", code => {
		finish(() => reject(new Error(`${binary} exited with code ${code} before providing a tunnel URL`)));
	});

	const abortHandler = (): void => {
		finish(() => reject(new Error("tunnel aborted")));
		child.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", abortHandler, { once: true });

	const url = await Promise.race([promise, delayReject(URL_TIMEOUT_MS)]);
	options.signal?.removeEventListener("abort", abortHandler);
	onStatus?.(`tunnel: public URL ${url}`);
	return {
		url,
		close: () => stopChild(child, onStatus),
	};
}

function delayReject(ms: number): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error("timed out waiting for tunnel URL")), ms);
	timer.unref?.();
	return promise;
}

async function stopChild(child: ChildProcess, onStatus?: (line: string) => void): Promise<void> {
	if (child.exitCode !== null || child.killed) return;
	onStatus?.("tunnel: stopping ngrok");
	child.kill("SIGTERM");
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		resolve();
	}, STOP_TIMEOUT_MS);
	timer.unref?.();
	child.on("exit", () => {
		clearTimeout(timer);
		resolve();
	});
	await promise;
}
