/**
 * Contract: ngrok tunnel lifecycle (alternative provider) — the public URL
 * is parsed from the JSON log on stdout, the promise settles only when the
 * URL appears (or the child exits / times out / aborts), and close()
 * terminates the child.
 *
 * Uses a fake `ngrok` binary (a node script) so the suite is hermetic.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractNgrokUrl, startNgrokTunnel } from "@musepi/pi-coding-agent/collab/ngrok";
import { compileNativeFixture } from "../helpers/native-fixture";

const FAKE_DIR = mkdtempSync(join(tmpdir(), "ngrok-fake-"));
let fakeIndex = 0;

async function fakeBinary(options: { output?: string; delayMs?: number; exitCode?: number }): Promise<string> {
	const target = join(FAKE_DIR, `ngrok-${fakeIndex++}${process.platform === "win32" ? ".exe" : ""}`);
	await compileNativeFixture(join(import.meta.dir, "..", "fixtures", "fake-ngrok.ts"), target, {
		"process.env.FAKE_NGROK_OUTPUT": JSON.stringify(options.output ?? ""),
		"process.env.FAKE_NGROK_EXIT_CODE": JSON.stringify(
			options.exitCode === undefined ? "" : String(options.exitCode),
		),
		"process.env.FAKE_NGROK_DELAY_MS": JSON.stringify(String(options.delayMs ?? 30)),
	});
	return target;
}

const SLOW_OK = await fakeBinary({
	output: '{"level":"info","msg":"started tunnel","url":"https://abc123.ngrok-free.app"}',
});

const DIES = await fakeBinary({ output: "ERR_NGROK_4010 invalid credentials", exitCode: 1, delayMs: 0 });

const SILENT = await fakeBinary({ delayMs: 0 });

const EXITS_ON_SIGTERM = await fakeBinary({ output: '{"url":"https://bye.ngrok-free.app"}', delayMs: 20 });

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
		const handle = await startNgrokTunnel({ port: 7654, verifyReachable: false, binary: SLOW_OK });
		expect(handle.url).toBe("https://abc123.ngrok-free.app");
		await handle.close();
	}, 30_000);

	it("rejects when ngrok exits before printing a URL", async () => {
		await expect(startNgrokTunnel({ port: 7654, verifyReachable: false, binary: DIES })).rejects.toThrow(
			/exited with code 1/,
		);
	}, 30_000);

	it("rejects after the URL timeout when ngrok stays silent", async () => {
		await expect(
			startNgrokTunnel({ port: 7654, verifyReachable: false, binary: SILENT, signal: abortAfter(80) }),
		).rejects.toThrow();
	}, 30_000);

	it("close() terminates the child via SIGTERM", async () => {
		const handle = await startNgrokTunnel({ port: 7654, verifyReachable: false, binary: EXITS_ON_SIGTERM });
		expect(handle.url).toBe("https://bye.ngrok-free.app");
		await handle.close();
	}, 30_000);

	it("rejects with an install hint when the binary is missing", async () => {
		const missing = join(FAKE_DIR, "definitely-not-ngrok");
		await expect(startNgrokTunnel({ port: 7654, verifyReachable: false, binary: missing })).rejects.toThrow(
			/ngrok is not installed.*add-authtoken/s,
		);
	}, 30_000);
});

function abortAfter(ms: number): AbortSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	return controller.signal;
}
