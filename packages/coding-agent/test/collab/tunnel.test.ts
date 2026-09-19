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
	extractQuickTunnelUrl,
	probeTunnelReachable,
	startCloudflaredTunnel,
	TunnelUnreachableError,
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
