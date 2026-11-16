import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startArtifactServer } from "./artifact-server";

/**
 * The artifact origin is the renderer's only delivery path for compiled slot
 * modules once it asks for URLs, so its cache contract is the contract: a
 * module URL survives a daemon restart and revalidates instead of travelling
 * again, while new bytes under the same key must never answer 304.
 */
it("serves a published module with an ETag and revalidates it to 304", async () => {
	const server = startArtifactServer();
	try {
		const url = server.publish("slot-abc", "export const A = 1;");
		const first = await fetch(url);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-cache");
		expect(first.headers.get("access-control-allow-origin")).toBe("*");
		expect(await first.text()).toContain("export const A = 1;");
		const etag = first.headers.get("etag");
		expect(etag).toBeTruthy();

		const revalidated = await fetch(url, { headers: { "if-none-match": etag ?? "" } });
		expect(revalidated.status).toBe(304);

		const missing = await fetch(new URL("/extensions/artifacts/absent", url));
		expect(missing.status).toBe(404);

		// Stylesheets are resources too, with their own content type.
		const cssUrl = server.publish("slot-abc-css", ".card{color:red}", "text/css; charset=utf-8");
		const css = await fetch(cssUrl);
		expect(css.status).toBe(200);
		expect(css.headers.get("content-type")).toContain("text/css");
		expect(await css.text()).toBe(".card{color:red}");

		server.publish("slot-abc", "export const A = 2;");
		const changed = await fetch(url, { headers: { "if-none-match": etag ?? "" } });
		expect(changed.status).toBe(200);
		expect(await changed.text()).toContain("export const A = 2;");
	} finally {
		await server.close();
	}
});

/**
 * Build-time artifacts are served from disk: the daemon must not read the whole
 * composition into memory to answer a registry call, and the validator has to
 * change when the file does.
 */
it("streams a published file and revalidates it by size and mtime", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "musepi-artifact-file-"));
	const server = startArtifactServer();
	try {
		const file = path.join(dir, "slot.js");
		await writeFile(file, "export const A = 1;");
		const url = server.publishFile("slot-file", file);
		const first = await fetch(url);
		expect(first.status).toBe(200);
		expect(await first.text()).toContain("export const A = 1;");
		const etag = first.headers.get("etag");
		expect(etag).toContain("-");
		const revalidated = await fetch(url, { headers: { "if-none-match": etag ?? "" } });
		expect(revalidated.status).toBe(304);

		// A rebuilt artifact differs in size, so the stored validator stops matching.
		await writeFile(file, "export const A = 22;");
		server.publishFile("slot-file", file);
		const changed = await fetch(url, { headers: { "if-none-match": etag ?? "" } });
		expect(changed.status).toBe(200);
		expect(await changed.text()).toContain("export const A = 22;");
	} finally {
		await server.close();
		await rm(dir, { recursive: true, force: true });
	}
});
