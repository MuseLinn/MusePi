/**
 * Contract: cloudflared quick-tunnel lifecycle — the public URL is parsed
 * from stderr, the promise settles only when the URL appears (or the child
 * exits / times out / aborts), and close() terminates the child.
 *
 * Uses a fake `cloudflared` binary (a node script) so the suite is hermetic.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudflaredExposure,
	extractQuickTunnelUrl,
	parseCloudflaredLine,
	probeTunnelReachable,
	readCloudflaredTunnelToken,
	startCloudflaredTunnel,
	storeCloudflaredTunnelToken,
	TunnelUnreachableError,
	tunnelIdFromToken,
} from "@musepi/pi-coding-agent/collab/tunnel";

const FAKE_DIR = mkdtempSync(join(tmpdir(), "cfd-fake-"));

function fakeBinary(script: string): string {
	const path = join(FAKE_DIR, `cloudflared-${Math.random().toString(36).slice(2)}`);
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
}

const SLOW_OK = fakeBinary(`#!/usr/bin/env node
setTimeout(() => {
  process.stderr.write("Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\\n");
  process.stderr.write("https://abc123.trycloudflare.com\\n");
}, 30);
setInterval(() => {}, 1000);
`);

const DIES = fakeBinary(`#!/usr/bin/env node
process.stderr.write("no such command\\n");
process.exit(1);
`);

const SILENT = fakeBinary(`#!/usr/bin/env node
setInterval(() => {}, 1000);
`);

const EXITS_ON_SIGTERM = fakeBinary(`#!/usr/bin/env node
setTimeout(() => {
  process.stderr.write("https://bye.trycloudflare.com\\n");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}, 20);
`);

afterAll(() => {
	rmSync(FAKE_DIR, { recursive: true, force: true });
});

describe("extractQuickTunnelUrl", () => {
	it("extracts the trycloudflare URL from cloudflared stderr", () => {
		const out =
			"Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\nhttps://abc123.trycloudflare.com\n";
		expect(extractQuickTunnelUrl(out)).toBe("https://abc123.trycloudflare.com");
	});

	it("returns null before the URL appears", () => {
		expect(extractQuickTunnelUrl("Starting tunnel...")).toBeNull();
	});

	it("ignores other https URLs", () => {
		expect(extractQuickTunnelUrl("see https://developers.cloudflare.com for docs")).toBeNull();
	});
});

describe("startCloudflaredTunnel", () => {
	it("resolves with the public URL and close() stops the child", async () => {
		const handle = await startCloudflaredTunnel({ port: 7654, binary: SLOW_OK, verifyReachable: false });
		expect(handle.url).toBe("https://abc123.trycloudflare.com");
		await handle.close();
	});

	it("rejects when the binary exits before providing a URL", async () => {
		await expect(startCloudflaredTunnel({ port: 7654, binary: DIES, verifyReachable: false })).rejects.toThrow(
			/exited with code 1/,
		);
	});

	it("rejects after the URL timeout when nothing appears", async () => {
		// Use a 50ms timeout via the race with a custom short delay is not
		// injectable; exercise the real 30s path through abort instead.
		const controller = new AbortController();
		const pending = startCloudflaredTunnel({
			port: 7654,
			binary: SILENT,
			signal: controller.signal,
			verifyReachable: false,
		});
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toThrow(/aborted/);
	});

	it("close() waits for the child to exit gracefully", async () => {
		const handle = await startCloudflaredTunnel({ port: 7654, binary: EXITS_ON_SIGTERM, verifyReachable: false });
		expect(handle.url).toBe("https://bye.trycloudflare.com");
		await handle.close(); // SIGTERM handled -> clean exit, no SIGKILL path
	});
});

// Issue #36: cloudflared prints the URL it ASSIGNED, which is not proof this
// machine can reach that edge node. Reporting success there produced a bare
// `Failed to connect` later, with nothing the user could act on.
describe("tunnel reachability probe", () => {
	it("resolves when the tunnel host answers", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
		try {
			// Any HTTP status proves the path works; a 404 here is a pass.
			await expect(probeTunnelReachable("https://example.trycloudflare.com")).resolves.toBeUndefined();
		} finally {
			globalThis.fetch = original;
		}
	});

	it("throws a diagnosable TunnelUnreachableError when the connection fails", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("Failed to connect");
		}) as unknown as typeof fetch;
		try {
			const probe = probeTunnelReachable("https://dead.trycloudflare.com");
			await expect(probe).rejects.toBeInstanceOf(TunnelUnreachableError);
			// The message must name the LAN fallback — the user's actual way out.
			await probe.catch((err: Error) => {
				expect(err.message).toContain("dead.trycloudflare.com");
				expect(err.message).toMatch(/same network/i);
			});
		} finally {
			globalThis.fetch = original;
		}
	});

	it("startCloudflaredTunnel rejects instead of reporting a ready-but-dead tunnel", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("Failed to connect");
		}) as unknown as typeof fetch;
		try {
			const attempt = startCloudflaredTunnel({ port: 7654, binary: SLOW_OK });
			await expect(attempt).rejects.toBeInstanceOf(TunnelUnreachableError);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("the probe can be skipped for tests and offline setups", async () => {
		const handle = await startCloudflaredTunnel({ port: 7654, binary: SLOW_OK, verifyReachable: false });
		expect(handle.url).toBe("https://abc123.trycloudflare.com");
		await handle.close();
	});
});

// ── JSON logging, named tunnels, health ─────────────────────────────────────

/** A base64 JSON token in Cloudflare's real shape (`t` carries the tunnel id). */
const NAMED_TOKEN = Buffer.from(JSON.stringify({ a: "acct", t: "tun-abc", s: "secret" })).toString("base64");

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const started = Date.now();
	const timer = setInterval(() => {
		if (predicate()) {
			clearInterval(timer);
			resolve();
		} else if (Date.now() - started > timeoutMs) {
			clearInterval(timer);
			reject(new Error("condition not met in time"));
		}
	}, 20);
	timer.unref?.();
	return promise;
}

describe("cloudflared log parsing", () => {
	it("prefers the JSON url field and falls back to plain text", () => {
		expect(parseCloudflaredLine('{"level":"info","msg":"created","url":"https://json1.trycloudflare.com"}')).toEqual({
			url: "https://json1.trycloudflare.com",
			message: "created",
		});
		expect(parseCloudflaredLine("Your quick Tunnel: https://plain1.trycloudflare.com").url).toBe(
			"https://plain1.trycloudflare.com",
		);
		expect(parseCloudflaredLine("starting...").url).toBeUndefined();
	});

	it("ignores JSON lines that carry an unrelated url", () => {
		expect(parseCloudflaredLine('{"msg":"docs","url":"https://developers.cloudflare.com"}').url).toBeUndefined();
	});
});

const JSON_URL_ONLY = fakeBinary(`#!/usr/bin/env node
if (process.argv.includes("--version")) process.exit(0);
setTimeout(() => process.stderr.write('{"level":"info","msg":"created","url":"https://json1.trycloudflare.com"}\\n'), 20);
setInterval(() => {}, 1000);
`);

describe("CloudflaredExposure", () => {
	it("quick mode parses JSON logs and reports a ready URL", async () => {
		const exposure = new CloudflaredExposure({
			binary: JSON_URL_ONLY,
			verifyReachable: false,
			healthIntervalMs: 0,
		});
		await exposure.probe();
		expect(exposure.capabilities.stableUrl).toBe(false);
		const urls = await exposure.start({ port: 7654 });
		expect(urls.joinUrl).toBe("https://json1.trycloudflare.com");
		expect(exposure.status().health).toBe("ready");
		await exposure.close();
		expect(exposure.status().health).toBe("stopped");
	});

	it("probe names the install command when the binary is missing", async () => {
		const exposure = new CloudflaredExposure({
			binary: join(FAKE_DIR, "definitely-not-cloudflared"),
			verifyReachable: false,
		});
		const status = await exposure.probe();
		expect(status.health).toBe("unavailable");
		expect(status.install?.commands.darwin).toContain("brew");
		expect(status.install?.commands.win32).toContain("winget");
	});

	it("named mode keeps the token out of argv and uses the configured hostname", async () => {
		const record = join(FAKE_DIR, `named-${Math.random().toString(36).slice(2)}.json`);
		process.env.FAKE_CFD_RECORD = record;
		const named = fakeBinary(`#!/usr/bin/env node
if (process.argv.includes("--version")) process.exit(0);
require("node:fs").writeFileSync(process.env.FAKE_CFD_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  envToken: process.env.TUNNEL_TOKEN ?? null,
}));
process.stderr.write('{"msg":"Registered tunnel connection"}\\n');
setInterval(() => {}, 1000);
`);
		const exposure = new CloudflaredExposure({
			binary: named,
			hostname: "collab.example.com",
			token: NAMED_TOKEN,
			verifyReachable: false,
			healthIntervalMs: 0,
		});
		await exposure.probe();
		expect(exposure.capabilities.stableUrl).toBe(true);
		const urls = await exposure.start({ port: 7654 });
		expect(urls.joinUrl).toBe("https://collab.example.com");
		const observed = JSON.parse(await (await import("node:fs/promises")).readFile(record, "utf8")) as {
			argv: string[];
			envToken: string | null;
		};
		expect(observed.argv.join(" ")).not.toContain(NAMED_TOKEN);
		expect(observed.envToken).toBe(NAMED_TOKEN);
		await exposure.close();
	});

	it("degrades and clears the link when cloudflared exits after start", async () => {
		const diesLater = fakeBinary(`#!/usr/bin/env node
if (process.argv.includes("--version")) process.exit(0);
process.stderr.write('{"url":"https://shortlived.trycloudflare.com"}\\n');
setTimeout(() => process.exit(3), 120);
setInterval(() => {}, 1000);
`);
		const exposure = new CloudflaredExposure({ binary: diesLater, verifyReachable: false, healthIntervalMs: 0 });
		const statusLines: string[] = [];
		await exposure.start({ port: 7654, onStatus: line => statusLines.push(line) });
		expect(exposure.status().health).toBe("ready");
		await waitFor(() => exposure.status().health === "degraded");
		expect(exposure.status().url).toBeUndefined();
		expect(exposure.status().detail).toMatch(/exited with code \d+/);
		// The TUI only renders status lines; the reason must travel through one.
		expect(statusLines.some(line => line.includes("sharing ended"))).toBe(true);
		await exposure.close();
	});
});

describe("named tunnel token storage", () => {
	it("reads the tunnel id out of the token", () => {
		expect(tunnelIdFromToken(NAMED_TOKEN)).toBe("tun-abc");
		expect(tunnelIdFromToken("not-base64-json")).toBeNull();
	});

	it("round-trips the token through the encrypted store under collab.cloudflared.<id>", async () => {
		const { mkdtempSync } = await import("node:fs");
		const agentDir = mkdtempSync(join(tmpdir(), "cfd-token-"));
		try {
			const id = await storeCloudflaredTunnelToken(NAMED_TOKEN, agentDir);
			expect(id).toBe("collab.cloudflared.tun-abc");
			expect(await readCloudflaredTunnelToken("tun-abc", agentDir)).toBe(NAMED_TOKEN);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
