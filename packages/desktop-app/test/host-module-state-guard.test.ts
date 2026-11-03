import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXTENSION_HOST_MODULES } from "@musepi/collab-proto/extension-host-modules";
// slot-host registers its own namespace with the table as the module loads, so
// it must be evaluated before the table is read — the app imports it the same way.
import "../src/lib/slot-host";
import { exposeHostModules } from "../src/lib/host-modules";

const LIB_DIR = resolve(import.meta.dir, "../src/lib");

/** State-bearing modules whose identity compiled plugins must share. */
const HOST_STATE_MODULES = [
	"update-ux",
	"tooltips",
	"action-toast",
	"file-workspace",
	"use-floating-menu",
	"prompt-dialog",
	"managed-browser-host",
	"slot-host",
	"monaco-runtime",
	"monaco-lsp",
] as const;

/** Call form only: an import or re-export of `createContext` is not a context. */
const CREATE_CONTEXT_CALL = /\bcreateContext\s*(?:<[^>\n]*>)?\s*\(/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/** Contract spelling of a lib file: `src/lib/prompt-dialog.tsx` -> `lib/prompt-dialog`. */
function contractPath(file: string): string {
	return `lib/${file
		.slice(LIB_DIR.length + 1)
		.replace(/\\/g, "/")
		.replace(/\.tsx?$/, "")}`;
}

function contractEntryFor(path: string) {
	return EXTENSION_HOST_MODULES.find(entry => "path" in entry && entry.path === path);
}

describe("host module state guard", () => {
	it("lists every lib module that creates a React context", () => {
		const files = sourceFiles(LIB_DIR);
		expect(files.length).toBeGreaterThan(0);

		const unregistered = files
			.filter(file => CREATE_CONTEXT_CALL.test(readFileSync(file, "utf8")))
			.map(contractPath)
			.filter(path => contractEntryFor(path) === undefined);

		expect(unregistered).toEqual([]);
	});

	it("declares a contract path for every known state-bearing module", () => {
		const missing = HOST_STATE_MODULES.map(name => `lib/${name}`).filter(
			path => contractEntryFor(path) === undefined,
		);

		expect(missing).toEqual([]);
	});

	it("publishes a bound instance for every known state-bearing module", () => {
		exposeHostModules();
		const published = (window as unknown as { MusePiHostModules?: Record<string, unknown> }).MusePiHostModules;
		expect(published).toBeDefined();

		const unpublished: string[] = [];
		for (const name of HOST_STATE_MODULES) {
			const entry = contractEntryFor(`lib/${name}`);
			if (entry === undefined) {
				unpublished.push(`${name}: no contract path`);
				continue;
			}
			const instance = published?.[entry.key];
			if (instance === undefined || instance === null) unpublished.push(`${entry.key}: not published`);
		}

		expect(unpublished).toEqual([]);
	});
});
