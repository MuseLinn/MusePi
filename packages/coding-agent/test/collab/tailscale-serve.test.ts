/**
 * Contract: Tailscale Serve integration.
 *
 * - the user's Serve config is backed up (`serve get-config`) and restored
 *   (`serve set-config`), never wiped with `serve reset`;
 * - 443 is preferred, an occupied 443 falls back to 8443 with the port in the
 *   link, and two occupied ports degrade with an actionable hint;
 * - not installed / not logged in / MagicDNS off / HTTPS unavailable each
 *   produce their own hint;
 * - MusePi never runs `tailscale up` and stores no credentials.
 *
 * Uses a fake `tailscale` binary (a node script) so the suite is hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	probeTailscale,
	startTailscaleServe,
	startTailscaleServeDetailed,
	TailscaleExposure,
} from "@musepi/pi-coding-agent/collab/tailscale-serve";

const FAKE_DIR = mkdtempSync(join(tmpdir(), "tailscale-fake-"));

interface Scenario {
	status?: Record<string, unknown> | null;
	serveStatus?: Record<string, unknown>;
	serveConfig?: Record<string, unknown>;
	serveBgExit?: number;
	serveBgStderr?: string;
}

function fakeBinary(scenario: Scenario): { binary: string; record: string } {
	const record = join(FAKE_DIR, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(argv) + "\\n");
const STATUS = ${JSON.stringify(scenario.status === undefined ? { BackendState: "Running", Self: { DNSName: "macbook.test-tailnet.ts.net." }, CurrentTailnet: { MagicDNSEnabled: true } } : scenario.status)};
const SERVE_STATUS = ${JSON.stringify(scenario.serveStatus ?? {})};
const SERVE_CONFIG = ${JSON.stringify(scenario.serveConfig ?? {})};
if (STATUS === null) {
  process.stderr.write("tailscaled is not running\\n");
  process.exit(1);
}
if (argv[0] === "status") {
  process.stdout.write(JSON.stringify(STATUS));
  process.exit(0);
}
if (argv[0] === "serve") {
  const sub = argv[1];
  if (sub === "status") { process.stdout.write(JSON.stringify(SERVE_STATUS)); process.exit(0); }
  if (sub === "get-config") { fs.writeFileSync(argv[2], JSON.stringify(SERVE_CONFIG)); process.exit(0); }
  if (sub === "set-config") { fs.copyFileSync(argv[2], ${JSON.stringify(record)} + ".restored"); process.exit(0); }
  if (sub === "--bg") {
    ${scenario.serveBgExit && scenario.serveBgExit !== 0 ? `process.stderr.write(${JSON.stringify(scenario.serveBgStderr ?? "serve failed")}); process.exit(${scenario.serveBgExit});` : ""}
    const port = argv[2].replace("--https=", "");
    process.stdout.write("Available within your tailnet:\\n\\nhttps://macbook.test-tailnet.ts.net" + (port === "443" ? "/" : ":" + port + "/") + "\\n");
    process.exit(0);
  }
  if (sub.startsWith("--https=")) { process.exit(0); } // off
}
process.exit(1);
`;
	const binary = join(FAKE_DIR, `tailscale-${Math.random().toString(36).slice(2)}`);
	writeFileSync(binary, script);
	chmodSync(binary, 0o755);
	return { binary, record };
}

function calls(record: string): string[][] {
	if (!existsSync(record)) return [];
	return readFileSync(record, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as string[]);
}

let backupDir: string;
beforeAll(() => {
	backupDir = mkdtempSync(join(tmpdir(), "tailscale-backup-"));
});

afterAll(() => {
	rmSync(FAKE_DIR, { recursive: true, force: true });
	rmSync(backupDir, { recursive: true, force: true });
});

describe("probeTailscale", () => {
	it("reports the MagicDNS name when the node is connected", async () => {
		const { binary } = fakeBinary({});
		const probe = await probeTailscale(binary);
		expect(probe.available).toBe(true);
		expect(probe.dnsName).toBe("macbook.test-tailnet.ts.net");
	});

	it("returns install data when the CLI is missing", async () => {
		const probe = await probeTailscale(join(FAKE_DIR, "definitely-not-tailscale"));
		expect(probe.available).toBe(false);
		expect(probe.install?.commands.darwin).toContain("tailscale");
		expect(probe.install?.url).toContain("tailscale.com");
	});

	it("names `tailscale up` when the node is not logged in", async () => {
		const { binary } = fakeBinary({ status: { BackendState: "NeedsLogin", Self: {} } });
		const probe = await probeTailscale(binary);
		expect(probe.available).toBe(false);
		expect(probe.hint).toContain("tailscale up");
	});

	it("names MagicDNS when it is disabled", async () => {
		const { binary } = fakeBinary({
			status: {
				BackendState: "Running",
				Self: { DNSName: "macbook.test-tailnet.ts.net." },
				CurrentTailnet: { MagicDNSEnabled: false },
			},
		});
		const probe = await probeTailscale(binary);
		expect(probe.available).toBe(false);
		expect(probe.detail).toContain("MagicDNS");
		expect(probe.hint).toContain("admin console");
	});
});

describe("startTailscaleServe", () => {
	it("serves on 443 and never resets the user's config", async () => {
		const { binary, record } = fakeBinary({});
		const handle = await startTailscaleServe({ port: 7654, binary, backupDir });
		expect(handle).not.toBeNull();
		expect(handle!.baseUrl).toBe("https://macbook.test-tailnet.ts.net");
		expect(handle!.httpsPort).toBe(443);
		await handle!.stop();
		const seen = calls(record);
		expect(seen.some(args => args.join(" ") === "serve --bg --https=443 http://localhost:7654")).toBe(true);
		expect(seen.some(args => args.join(" ") === "serve --https=443 off")).toBe(true);
		expect(seen.some(args => args.includes("reset"))).toBe(false);
	});

	it("falls back to 8443 when 443 is already served and keeps the port in the link", async () => {
		const existing = { TCP: { "443": { HTTPS: true } } };
		const { binary, record } = fakeBinary({ serveStatus: existing, serveConfig: existing });
		const handle = await startTailscaleServe({ port: 7654, binary, backupDir });
		expect(handle?.baseUrl).toBe("https://macbook.test-tailnet.ts.net:8443");
		expect(handle?.httpsPort).toBe(8443);
		await handle!.stop();
		const seen = calls(record);
		expect(seen.some(args => args.join(" ") === "serve --bg --https=8443 http://localhost:7654")).toBe(true);
		expect(seen.some(args => args.join(" ") === "serve --https=8443 off")).toBe(true);
		expect(seen.some(args => args.includes("reset"))).toBe(false);
	});

	it("restores the pre-existing config with set-config after removing its own entry", async () => {
		const existing = { TCP: { "443": { HTTPS: true } } };
		const { binary, record } = fakeBinary({
			serveStatus: existing,
			serveConfig: {
				TCP: { "443": { HTTPS: true, Web: { "macbook.test-tailnet.ts.net:443": { Handlers: { "/": {} } } } } },
			},
		});
		const handle = await startTailscaleServe({ port: 7654, binary, backupDir });
		await handle!.stop();
		const seen = calls(record);
		const offIndex = seen.findIndex(args => args.join(" ") === "serve --https=8443 off");
		const restoreIndex = seen.findIndex(args => args[1] === "set-config");
		expect(offIndex).toBeGreaterThanOrEqual(0);
		expect(restoreIndex).toBeGreaterThan(offIndex);
		expect(existsSync(`${record}.restored`)).toBe(true);
		const restored = JSON.parse(readFileSync(`${record}.restored`, "utf8")) as Record<string, unknown>;
		expect(restored.TCP).toEqual({
			"443": { HTTPS: true, Web: { "macbook.test-tailnet.ts.net:443": { Handlers: { "/": {} } } } },
		});
	});

	it("degrades when both 443 and 8443 are served", async () => {
		const { binary, record } = fakeBinary({
			serveStatus: { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } } },
		});
		const { handle, failure } = await startTailscaleServeDetailed({ port: 7654, binary, backupDir });
		expect(handle).toBeNull();
		expect(failure?.detail).toContain("443 and 8443");
		expect(failure?.hint).toContain("tailscale serve status");
		expect(calls(record).some(args => args[1] === "--bg")).toBe(false);
	});

	it("degrades with an HTTPS hint when certificates are not enabled", async () => {
		const { binary } = fakeBinary({
			serveBgExit: 1,
			serveBgStderr: "error: HTTPS is not enabled for this tailnet",
		});
		const { handle, failure } = await startTailscaleServeDetailed({ port: 7654, binary, backupDir });
		expect(handle).toBeNull();
		expect(failure?.hint).toContain("HTTPS certificates");
	});

	it("returns null without starting anything when the CLI is missing", async () => {
		expect(await startTailscaleServe({ port: 7654, binary: join(FAKE_DIR, "missing-ts"), backupDir })).toBeNull();
	});
});

describe("TailscaleExposure", () => {
	it("starts on the tailnet and reports a stable URL with guest-install capability", async () => {
		const { binary } = fakeBinary({});
		const exposure = new TailscaleExposure({ binary, backupDir });
		await exposure.probe();
		expect(exposure.capabilities).toMatchObject({ guestInstall: true, stableUrl: true, publicExposure: false });
		const urls = await exposure.start({ port: 7654 });
		expect(urls.joinUrl).toBe("wss://macbook.test-tailnet.ts.net");
		expect(urls.webUrl).toBe("https://macbook.test-tailnet.ts.net");
		expect(exposure.status().health).toBe("ready");
		await exposure.close();
		expect(exposure.status().health).toBe("stopped");
	});

	it("stays unusable with an install card when tailscale is missing", async () => {
		const exposure = new TailscaleExposure({ binary: join(FAKE_DIR, "nope") });
		const status = await exposure.probe();
		expect(status.health).toBe("unavailable");
		expect(status.install?.commands.win32).toContain("winget");
		await expect(exposure.start({ port: 7654 })).rejects.toThrow(/not installed/);
	});
});
