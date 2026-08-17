/**
 * Contract: ngrok tunnel lifecycle (alternative provider) — the public URL
 * is parsed from the JSON log on stdout, the promise settles only when the
 * URL appears (or the child exits / times out / aborts), and close()
 * terminates the child.
 *
 * Uses a fake `ngrok` binary (a node script) so the suite is hermetic.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractNgrokUrl, startNgrokTunnel } from "@musepi/pi-coding-agent/collab/ngrok";

const FAKE_DIR = mkdtempSync(join(tmpdir(), "ngrok-fake-"));

function fakeBinary(script: string): string {
	const path = join(FAKE_DIR, `ngrok-${Math.random().toString(36).slice(2)}`);
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
}

const SLOW_OK = fakeBinary(`#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write('{"level":"info","msg":"started tunnel","url":"https://abc123.ngrok-free.app"}\\n');
}, 30);
setInterval(() => {}, 1000);
`);

const DIES = fakeBinary(`#!/usr/bin/env node
process.stderr.write("ERR_NGROK_4010 invalid credentials\\n");
process.exit(1);
`);

const SILENT = fakeBinary(`#!/usr/bin/env node
setInterval(() => {}, 1000);
`);

const EXITS_ON_SIGTERM = fakeBinary(`#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write('{"url":"https://bye.ngrok-free.app"}\\n');
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}, 20);
`);

afterAll(() => {
	rmSync(FAKE_DIR, { recursive: true, force: true });
});

describe("extractNgrokUrl", () => {
	it("extracts ngrok URLs from JSON log output", () => {
		const out = '{"level":"info","msg":"started tunnel","url":"https://abc123.ngrok-free.app"}\n';
		expect(extractNgrokUrl(out)).toBe("https://abc123.ngrok-free.app");
		expect(extractNgrokUrl('{"url":"https://x42.ngrok.app"}')).toBe("https://x42.ngrok.app");
	});

	it("returns null before the URL appears", () => {
		expect(extractNgrokUrl("starting tunnel...")).toBeNull();
	});
});

describe("startNgrokTunnel", () => {
	it("resolves with the public URL once ngrok prints it", async () => {
		const handle = await startNgrokTunnel({ port: 7654, binary: SLOW_OK });
		expect(handle.url).toBe("https://abc123.ngrok-free.app");
		await handle.close();
	});

	it("rejects when ngrok exits before printing a URL", async () => {
		await expect(startNgrokTunnel({ port: 7654, binary: DIES })).rejects.toThrow(/exited with code 1/);
	});

	it("rejects after the URL timeout when ngrok stays silent", async () => {
		await expect(startNgrokTunnel({ port: 7654, binary: SILENT, signal: abortAfter(80) })).rejects.toThrow();
	}, 5_000);

	it("close() terminates the child via SIGTERM", async () => {
		const handle = await startNgrokTunnel({ port: 7654, binary: EXITS_ON_SIGTERM });
		expect(handle.url).toBe("https://bye.ngrok-free.app");
		await handle.close();
	});

	it("rejects with an install hint when the binary is missing", async () => {
		const missing = join(FAKE_DIR, "definitely-not-ngrok");
		await expect(startNgrokTunnel({ port: 7654, binary: missing })).rejects.toThrow(
			/ngrok is not installed.*add-authtoken/s,
		);
	});
});

function abortAfter(ms: number): AbortSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	return controller.signal;
}
