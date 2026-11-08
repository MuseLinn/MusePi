/**
 * Track A entry contract: every bundled plugin is a named Cordis entry
 * (`name` / `inject` / `apply`), never a default export, and registers through
 * the `ctx.*` namespaces rather than the flat `pi.register*` aliases.
 *
 * A plugin that drifts here fails silently at load — the loader reports
 * "exports nothing loadable" and the feature simply disappears — so the shape
 * is pinned by test instead of by review.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGINS_DIR = path.join(import.meta.dir, "..", "src", "bundled-plugins");
const FLAT_REGISTRATION = /\bpi\.register[A-Z]\w*\s*\(/;

function pluginDirs(): string[] {
	return fs
		.readdirSync(PLUGINS_DIR, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(PLUGINS_DIR, entry.name))
		.filter(dir => fs.existsSync(path.join(dir, "index.ts")))
		.sort();
}

function typescriptFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".ts"))
		.map(name => path.join(dir, name));
}

describe("bundled plugin conformance", () => {
	it("exports a named Cordis entry from every package", () => {
		const offenders: string[] = [];
		for (const dir of pluginDirs()) {
			const rel = path.relative(PLUGINS_DIR, dir);
			const entry = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
			if (!/^export const name = /m.test(entry)) offenders.push(`${rel}: missing export const name`);
			if (!/^export const inject = /m.test(entry)) offenders.push(`${rel}: missing export const inject`);
			if (!/^export (async )?function apply\(/m.test(entry)) offenders.push(`${rel}: missing export function apply`);
			if (/^export default/m.test(entry)) offenders.push(`${rel}: default export is not a Cordis entry`);
			for (const file of typescriptFiles(dir)) {
				if (FLAT_REGISTRATION.test(fs.readFileSync(file, "utf8"))) {
					offenders.push(`${path.relative(PLUGINS_DIR, file)}: uses a flat pi.register* alias`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps every manifest entry pointing at a real file", () => {
		const missing: string[] = [];
		for (const dir of pluginDirs()) {
			const manifestPath = path.join(dir, "package.json");
			if (!fs.existsSync(manifestPath)) continue;
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
				musepi?: { extensions?: unknown; components?: unknown };
			};
			for (const field of [manifest.musepi?.extensions, manifest.musepi?.components]) {
				if (!Array.isArray(field)) continue;
				for (const candidate of field) {
					if (typeof candidate !== "string") continue;
					if (!fs.existsSync(path.join(dir, candidate))) {
						missing.push(`${path.relative(PLUGINS_DIR, dir)}: ${candidate}`);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
