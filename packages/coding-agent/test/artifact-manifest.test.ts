import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	validateArtifactManifest,
	validateArtifactManifestFile,
} from "@musepi/pi-coding-agent/presets/artifact-manifest";

let dir: string;

beforeEach(() => {
	dir = join(tmpdir(), `musepi-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>hi</body></html>");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const valid = {
	entry: "index.html",
	kind: "page",
	renderer: "html",
	exports: ["png"],
	title: "Landing v1",
	description: "hero + pricing",
};

describe("validateArtifactManifest", () => {
	test("accepts a valid manifest and resolves the entry path", () => {
		const { errors, value } = validateArtifactManifest(valid, dir);
		expect(errors).toEqual([]);
		expect(value?.manifest.kind).toBe("page");
		expect(value?.entryPath.replace(/\\/g, "/")).toBe(join(dir, "index.html").replace(/\\/g, "/"));
	});

	test("rejects a missing entry and unknown kind/renderer", () => {
		const { errors } = validateArtifactManifest({ kind: "poster", renderer: "html" }, dir);
		expect(errors.some(e => e.includes("entry is required"))).toBe(true);
		const { errors: errors2 } = validateArtifactManifest({ ...valid, kind: "widget" }, dir);
		expect(errors2.some(e => e.includes("kind must be one of"))).toBe(true);
		const { errors: errors3 } = validateArtifactManifest({ ...valid, renderer: "svg" }, dir);
		expect(errors3.some(e => e.includes("renderer must be one of"))).toBe(true);
	});

	test("rejects absolute entries and .. escapes (panel stays inside the artifact dir)", () => {
		for (const entry of ["C:\\evil\\x.html", "/etc/passwd", "../secret.html", "a/../../b.html"]) {
			const { errors } = validateArtifactManifest({ ...valid, entry }, dir);
			expect(errors.some(e => e.includes("must stay inside the artifact directory"))).toBe(true);
		}
	});

	test("flags a missing entry file only when the path shape is valid", () => {
		const { errors } = validateArtifactManifest({ ...valid, entry: "nope.html" }, dir);
		expect(errors).toEqual([expect.stringContaining("entry file does not exist")]);
	});

	test("validates exports shape and optional strings", () => {
		const bad = validateArtifactManifest({ ...valid, exports: [1, 2] }, dir);
		expect(bad.errors.some(e => e.includes("exports must be an array of strings"))).toBe(true);
		const badTitle = validateArtifactManifest({ ...valid, title: 42 }, dir);
		expect(badTitle.errors.some(e => e.includes("title must be a string"))).toBe(true);
	});
});

describe("validateArtifactManifestFile", () => {
	test("reads a sidecar manifest from disk", () => {
		const p = join(dir, "artifact.manifest.json");
		writeFileSync(p, JSON.stringify(valid));
		const { errors, value } = validateArtifactManifestFile(p);
		expect(errors).toEqual([]);
		expect(value?.manifest.title).toBe("Landing v1");
	});

	test("reports malformed JSON instead of throwing", () => {
		const p = join(dir, "artifact.manifest.json");
		writeFileSync(p, "{ broken");
		const { errors } = validateArtifactManifestFile(p);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("not valid JSON");
	});
});
