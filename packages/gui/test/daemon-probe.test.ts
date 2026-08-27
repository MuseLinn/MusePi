import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types;
// the surface it exercises here (probeWeb/WEB_PORT_FILE) is trivial.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { probeWeb, WEB_PORT_FILE } from "../electron/daemon.cjs";

/** Desktop-shell discovery (dsh-desktop parity): the daemon writes web.port
 *  beside daemon.sock when the shell extension is enabled; the Electron shell
 *  reads it to load the runtime-served renderer (absent -> local bundle). */
describe("daemon.cjs probeWeb (desktop shell discovery)", () => {
	it("returns the loopback renderer URL when web.port exists", async () => {
		await fs.mkdir(path.dirname(WEB_PORT_FILE), { recursive: true });
		await fs.writeFile(WEB_PORT_FILE, "6477", "utf8");
		try {
			expect(probeWeb()).toBe("http://127.0.0.1:6477/");
		} finally {
			await fs.rm(WEB_PORT_FILE, { force: true });
		}
	});

	it("returns null when web.port is absent (shell uses the local bundle)", async () => {
		await fs.rm(WEB_PORT_FILE, { force: true });
		expect(probeWeb()).toBeNull();
	});

	it("ignores a malformed web.port", async () => {
		await fs.mkdir(path.dirname(WEB_PORT_FILE), { recursive: true });
		await fs.writeFile(WEB_PORT_FILE, "not-a-port", "utf8");
		try {
			expect(probeWeb()).toBeNull();
		} finally {
			await fs.rm(WEB_PORT_FILE, { force: true });
		}
	});
});
