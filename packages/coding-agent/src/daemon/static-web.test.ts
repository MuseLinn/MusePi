import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { startDaemonWeb } from "./static-web";

/** The compat renderer dist the daemon serves (desktop-web/dist, sibling). */
const DIST_DIR = path.resolve(import.meta.dir, "../../../desktop-web", "dist");

/** dsh-desktop-compat "runtime serves the renderer" half: the loopback HTTP
 *  static server must serve the built SPA + SPA-fallback, and refuse path
 *  traversal — the Electron compat shell loadURLs this origin, leaving the
 *  served content authoritative. */
describe("startDaemonWeb (compat renderer server)", () => {
	it("serves the renderer index at /", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			const res = await fetch(`${handle.url}`);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("<!doctype html>");
			const type = res.headers.get("content-type");
			expect(type?.includes("text/html")).toBe(true);
		} finally {
			await handle.close();
		}
	});

	it("SPA-falls-back a non-asset path to index.html", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			const res = await fetch(`${new URL("/some/client/route", handle.url)}`);
			expect(res.status).toBe(200);
			await expect(res.text()).resolves.toContain("<!doctype html>");
		} finally {
			await handle.close();
		}
	});

	it("refuses path traversal (resolves inside distDir)", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			// Encoded ../ so the URL constructor does not collapse it before
			// the server's decodeURIComponent sees the traversal.
			const res = await fetch(`${handle.url}/..%2f..%2f..%2fpackage.json`);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("<!doctype html>");
			expect(body).not.toContain('"@musepi/coding-agent"');
		} finally {
			await handle.close();
		}
	});

	it("rejects a missing renderer dist (non-fatal at daemon start)", async () => {
		const missing = path.join(DIST_DIR, "does-not-exist");
		await expect(startDaemonWeb({ port: 0, distDir: missing })).rejects.toThrow(/renderer dist not found/);
	});

	it("serves the boot config at /__daemon.json (host-mode connect)", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR, wsPort: 8333, token: "secret-token" });
		try {
			const res = await fetch(`${new URL("/__daemon.json", handle.url)}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")?.includes("application/json")).toBe(true);
			const config = (await res.json()) as { wsUrl?: string; token?: string };
			expect(config.wsUrl).toBe("ws://127.0.0.1:8333/");
			expect(config.token).toBe("secret-token");
		} finally {
			await handle.close();
		}
	});

	it("omits wsUrl from the boot config without a WS port", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			const res = await fetch(`${new URL("/__daemon.json", handle.url)}`);
			expect(res.status).toBe(200);
			const config = (await res.json()) as { wsUrl?: string };
			expect(config.wsUrl).toBeUndefined();
		} finally {
			await handle.close();
		}
	});

	it("injects the compat slot host for ?shell=1 (Electron compat shell)", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			const res = await fetch(`${new URL("/?shell=1", handle.url)}`);
			expect(res.status).toBe(200);
			const html = await res.text();
			// The compat host script + its registry contract are injected.
			expect(html).toContain("MusePiCompatHost");
			expect(html).toContain("extensions.list");
		} finally {
			await handle.close();
		}
	});

	it("never injects the compat slot host for plain browsers (no ?shell=1)", async () => {
		const handle = await startDaemonWeb({ port: 0, distDir: DIST_DIR });
		try {
			const res = await fetch(handle.url);
			const html = await res.text();
			expect(html).not.toContain("MusePiCompatHost");
		} finally {
			await handle.close();
		}
	});
});
