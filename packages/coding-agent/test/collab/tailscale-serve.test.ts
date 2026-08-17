/**
 * Contract: tailscale serve integration — starts only when no user-managed
 * serve config exists (never clobbers it), parses the ts.net base URL,
 * degrades to null on any failure (no CLI, HTTPS unavailable, serve error),
 * and stop() resets the config it created.
 *
 * Uses a fake `tailscale` binary (a node script) so the suite is hermetic.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTailscaleServe } from "@musepi/pi-coding-agent/collab/tailscale-serve";

const FAKE_DIR = mkdtempSync(join(tmpdir(), "tailscale-fake-"));

function fakeBinary(script: string): string {
	const path = join(FAKE_DIR, `tailscale-${Math.random().toString(36).slice(2)}`);
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
}

const EMPTY_STATUS = fakeBinary(`#!/usr/bin/env node
if (process.argv[2] === "serve" && process.argv[3] === "status") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
if (process.argv[2] === "serve" && process.argv[3] === "--bg") {
  process.stdout.write("Available within your tailnet:\\n\\nhttps://macbook.test-tailnet.ts.net/\\n|-- proxy http://localhost:PORT\\n");
  process.exit(0);
}
if (process.argv[2] === "serve" && process.argv[3] === "reset") { process.exit(0); }
process.exit(1);
`);

const HAS_CONFIG = fakeBinary(`#!/usr/bin/env node
if (process.argv[2] === "serve" && process.argv[3] === "status") {
  process.stdout.write('{"TCP": {"443": {"HTTP": true}}}');
  process.exit(0);
}
process.exit(1);
`);

const CLI_MISSING = join(FAKE_DIR, "definitely-not-tailscale");

const SERVE_FAILS = fakeBinary(`#!/usr/bin/env node
if (process.argv[2] === "serve" && process.argv[3] === "status") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.stderr.write("HTTPS is a paid feature\\n");
process.exit(1);
`);

afterAll(() => {
	rmSync(FAKE_DIR, { recursive: true, force: true });
});

describe("startTailscaleServe", () => {
	it("starts serve and returns the ts.net base URL; stop() resets", async () => {
		const handle = await startTailscaleServe({ port: 7654, binary: EMPTY_STATUS });
		expect(handle).not.toBeNull();
		expect(handle!.baseUrl).toBe("https://macbook.test-tailnet.ts.net");
		await handle!.stop();
	});

	it("returns null when a user-managed serve config already exists", async () => {
		await expect(startTailscaleServe({ port: 7654, binary: HAS_CONFIG })).resolves.toBeNull();
	});

	it("returns null when the binary is missing", async () => {
		await expect(startTailscaleServe({ port: 7654, binary: CLI_MISSING })).resolves.toBeNull();
	});

	it("degrades to null when serve fails (HTTPS unavailable)", async () => {
		await expect(startTailscaleServe({ port: 7654, binary: SERVE_FAILS })).resolves.toBeNull();
	});
});
