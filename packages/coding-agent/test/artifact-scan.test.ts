import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readArtifactEntryText, scanWorkspaceArtifacts } from "../src/daemon/artifact-scan";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-scan-test-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a valid sidecar manifest + entry file into `relDir`. */
function seedArtifact(relDir: string, overrides: Record<string, unknown> = {}): void {
	const abs = path.join(dir, relDir);
	fs.mkdirSync(abs, { recursive: true });
	const entryName = typeof overrides.entry === "string" ? overrides.entry : "index.html";
	const manifest = {
		entry: entryName,
		kind: "page",
		renderer: "html",
		...overrides,
	};
	fs.writeFileSync(path.join(abs, "artifact.manifest.json"), JSON.stringify(manifest), "utf8");
	fs.writeFileSync(path.join(abs, entryName), `<h1>${relDir}</h1>`, "utf8");
}

describe("scanWorkspaceArtifacts", () => {
	it("finds and validates manifests across the workspace", () => {
		seedArtifact("products/landing", { title: "Landing Page", exports: ["png"] });
		seedArtifact("poster", { entry: "poster.html", kind: "poster", renderer: "html" });
		fs.writeFileSync(path.join(dir, "readme.md"), "no artifact here", "utf8");

		const res = scanWorkspaceArtifacts(dir);
		expect(res.truncated).toBe(false);
		expect(res.artifacts).toHaveLength(2);

		const landing = res.artifacts.find(a => a.dir === "products/landing");
		expect(landing).toBeDefined();
		expect(landing!.title).toBe("Landing Page");
		expect(landing!.kind).toBe("page");
		expect(landing!.renderer).toBe("html");
		expect(landing!.exports).toEqual(["png"]);
		expect(landing!.dirName).toBe("landing");
		expect(landing!.errors).toBeUndefined();

		const poster = res.artifacts.find(a => a.dir === "poster");
		expect(poster).toBeDefined();
		// title falls back to the entry file name
		expect(poster!.title).toBe("poster.html");
	});

	it("skips node_modules, dotdirs, and ignores plain files", () => {
		seedArtifact("node_modules/pkg/dist", {});
		seedArtifact(".hidden/artifact", {});
		seedArtifact("real", {});
		fs.writeFileSync(path.join(dir, "stray.manifest.json"), "{}", "utf8");

		const res = scanWorkspaceArtifacts(dir);
		expect(res.artifacts.map(a => a.dir)).toEqual(["real"]);
	});

	it("lists invalid manifests with their errors instead of dropping them", () => {
		const abs = path.join(dir, "broken");
		fs.mkdirSync(abs);
		fs.writeFileSync(
			path.join(abs, "artifact.manifest.json"),
			JSON.stringify({ entry: "../escape.html", kind: "page", renderer: "html" }),
			"utf8",
		);

		const res = scanWorkspaceArtifacts(dir);
		expect(res.artifacts).toHaveLength(1);
		expect(res.artifacts[0]!.errors).toBeDefined();
		expect(res.artifacts[0]!.errors!.some(e => e.includes("inside the artifact directory"))).toBe(true);
	});

	it("flags truncation when the depth cap cuts the walk", () => {
		seedArtifact("a/b/c/d/e/deep", {});
		const res = scanWorkspaceArtifacts(dir, 2);
		expect(res.artifacts).toHaveLength(0);
		expect(res.truncated).toBe(true);
	});
});

describe("readArtifactEntryText", () => {
	it("reads the entry file text", () => {
		seedArtifact("site");
		const res = readArtifactEntryText(dir, "site", "index.html");
		expect("text" in res && res.text).toBe("<h1>site</h1>");
		expect("truncated" in res && res.truncated).toBe(false);
	});

	it("rejects entry paths that escape the artifact directory", () => {
		seedArtifact("site");
		fs.writeFileSync(path.join(dir, "secret.txt"), "top secret", "utf8");
		const res = readArtifactEntryText(dir, "site", "../secret.txt");
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error).toContain("escapes");
	});

	it("rejects artifact dirs that escape the workspace", () => {
		const res = readArtifactEntryText(dir, "../outside", "index.html");
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error).toContain("escapes");
	});

	it("rejects absolute entry paths and missing files", () => {
		seedArtifact("site");
		expect("error" in readArtifactEntryText(dir, "site", "/etc/passwd")).toBe(true);
		expect("error" in readArtifactEntryText(dir, "site", "nope.html")).toBe(true);
	});

	it("flags oversized entries as truncated", () => {
		const abs = path.join(dir, "big");
		fs.mkdirSync(abs);
		fs.writeFileSync(
			path.join(abs, "artifact.manifest.json"),
			JSON.stringify({ entry: "big.html", kind: "page", renderer: "html" }),
			"utf8",
		);
		fs.writeFileSync(path.join(abs, "big.html"), "x".repeat(600 * 1024), "utf8");
		const res = readArtifactEntryText(dir, "big", "big.html");
		expect("truncated" in res && res.truncated).toBe(true);
	});
});
