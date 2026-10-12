/**
 * The example plugin package, exercised the way a host runs a factory.
 *
 * This is the first real plugin package in the tree, so what it proves matters
 * more than what it does:
 *
 * - A package's entry registers a magic keyword through
 *   `pi.registerMagicKeyword` — an extension can now contribute a capability
 *   the host previously only had compiled in.
 * - The keyword reaches the registry a session reads, and is droppable, so a
 *   disabled extension stops contributing it.
 * - Its declared settings components compile through the real artifact
 *   pipeline, and its RPC is callable.
 *
 * Run through `loadExtensionFromFactory` rather than the full discovery path:
 * this is the package's own contract, and a discovery scan has nothing to do
 * with whether the package contributes what it declares.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { validateExtensionComponents } from "../src/daemon/extension-artifact-compiler";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import type { ExtensionFactory } from "../src/extensibility/extensions/types";
import {
	containsMagicKeyword,
	listMagicKeywordHighlighters,
	listMagicKeywords,
	registerMagicKeyword,
	resetMagicKeywordRegistry,
	unregisterMagicKeyword,
} from "../src/modes/magic-keyword-registry";
import { EventBus } from "../src/utils/event-bus";

const entry = path.join(import.meta.dirname, "..", "examples", "plugin-magic-keyword", "index.ts");

/** Load the example package's entry as a host would. */
async function load() {
	const mod = (await import(entry)) as { default: ExtensionFactory };
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(mod.default, process.cwd(), new EventBus(), runtime, entry);
	return { extension, runtime };
}

describe("example plugin-magic-keyword", () => {
	// The registry is process-level; every test starts from a clean one so a
	// registration in one case cannot satisfy an assertion in another.
	beforeEach(() => {
		resetMagicKeywordRegistry();
	});

	afterEach(() => {
		resetMagicKeywordRegistry();
	});

	it("contributes one magic keyword with a real notice", async () => {
		const { runtime } = await load();

		expect(runtime.pendingMagicKeywordRegistrations).toHaveLength(1);
		const registered = runtime.pendingMagicKeywordRegistrations[0];
		expect(registered?.name).toBe("deepdive");
		// The notice is read from the package's prompt file, not inlined.
		expect(registered?.notice.length ?? 0).toBeGreaterThan(80);
		expect(registered?.noticeType).toBe("deepdive-notice");
		// A gradient, so the editor paints the word as it is typed — the same
		// affordance the built-in keywords have.
		expect(registered?.highlight).toEqual({ from: 190, to: 265 });
	});

	it("contributes a highlighter that paints the word, like the built-ins do", async () => {
		const { runtime } = await load();
		for (const keyword of runtime.pendingMagicKeywordRegistrations) {
			registerMagicKeyword(keyword);
		}

		const highlighters = listMagicKeywordHighlighters();
		expect(highlighters).toHaveLength(1);
		// The highlighter is compiled and ready for the editor to chain. Painting
		// itself resolves colors per color mode through the theme singleton,
		// which the test shim does not initialize — the session-level suite
		// exercises the painting path against a live theme.
		expect(typeof highlighters[0]).toBe("function");

		unregisterMagicKeyword("deepdive");
		// Dropped with the keyword: a word must not outlive its extension.
		expect(listMagicKeywordHighlighters()).toEqual([]);
	});

	it("registers into the registry a session reads, and drops again", async () => {
		const { runtime } = await load();

		// Replay the queue the way session initialization does.
		for (const keyword of runtime.pendingMagicKeywordRegistrations) {
			registerMagicKeyword(keyword);
		}
		expect(listMagicKeywords().map(k => k.name)).toEqual(["deepdive"]);

		unregisterMagicKeyword("deepdive");
		expect(listMagicKeywords()).toEqual([]);
	});

	it("matches its keyword in prose but never inside code or a longer word", async () => {
		const { runtime } = await load();
		const keyword = runtime.pendingMagicKeywordRegistrations[0];
		if (!keyword) throw new Error("keyword should be registered");

		expect(containsMagicKeyword(keyword, "please deepdive into this")).toBe(true);
		expect(containsMagicKeyword(keyword, "deepdiving now")).toBe(false);
		expect(containsMagicKeyword(keyword, "run deepdive.ts")).toBe(false);
		expect(containsMagicKeyword(keyword, "call `deepdive` here")).toBe(false);
	});

	it("compiles every settings component it declares", async () => {
		const { extension } = await load();

		// `resolvedPath` is the entry; components resolve relative to its dir.
		const resolved = path.join(import.meta.dirname, "..", "examples", "plugin-magic-keyword", "index.ts");
		const failures = await validateExtensionComponents({
			resolvedPath: resolved,
			components: extension.components,
		});

		expect(extension.components.map(c => c.slot).sort()).toEqual(["settings.extensions", "settings.tab.deepdive"]);
		expect(failures).toEqual([]);
	});

	it("exposes its describe RPC with the keyword and its setting key", async () => {
		const { extension } = await load();

		const handler = extension.rpcs.get("deepdive.describe");
		expect(handler).toBeDefined();
		if (handler) {
			const answer = (await handler({}, { cwd: process.cwd() })) as {
				keyword: string;
				settingKey: string;
			};
			expect(answer.keyword).toBe("deepdive");
			expect(answer.settingKey).toBe("magicKeywords.deepdive");
		}
	});
});
