/**
 * Cordis plugin primitives — `effect` and `state`.
 *
 * Why these tests exist: both primitives replace a module-level variable, which
 * is the wrong home for plugin state because the same module can be instantiated
 * more than once per process. The observable failure modes this guards against:
 *
 * - a cleanup registered via `pi.effect` never runs → a reloaded plugin leaves
 *   an orphaned timer/socket behind, and five reloads leave four;
 * - state written in one mount is visible in the next → a plugin sees stale
 *   data from a previous life;
 * - one throwing cleanup stops the rest → resources stranded silently.
 *
 * Both are keyed by the `Extension` object the mount pipeline owns, so the tests
 * build one directly rather than going through a full mount.
 */

import { describe, expect, test } from "bun:test";
import type { Extension } from "../src/extensibility/extensions/types";
import {
	disposeFailedPluginPrimitives,
	disposePluginPrimitives,
	pendingEffectCount,
	registerEffect,
	stateDelete,
	stateGet,
	stateHas,
	stateKeys,
	stateSet,
} from "../src/extensibility/plugins/runtime/cordis-primitives";

/** A minimal `Extension` — the primitives only use it as an identity key. */
function fakeExtension(): Extension {
	return { path: "/tmp/plugin.ts", resolvedPath: "/tmp/plugin.ts" } as Extension;
}

describe("plugin effect", () => {
	test("a registered cleanup runs on dispose", async () => {
		// The whole point: a side effect the plugin opened itself is reclaimed
		// when the plugin goes. Before `effect` there was no way to do this.
		const ext = fakeExtension();
		let closed = 0;
		registerEffect(ext, () => {
			closed += 1;
		});
		expect(closed).toBe(0);

		const ran = await disposePluginPrimitives(ext);
		expect(ran).toBe(1);
		expect(closed).toBe(1);
	});

	test("dispose is idempotent — a second pass runs nothing", async () => {
		// Unload and reload can both reach dispose; a cleanup must not fire twice.
		const ext = fakeExtension();
		let closed = 0;
		registerEffect(ext, () => {
			closed += 1;
		});
		await disposePluginPrimitives(ext);
		const second = await disposePluginPrimitives(ext);
		expect(second).toBe(0);
		expect(closed).toBe(1);
	});

	test("cleanups run in reverse registration order", async () => {
		// Inner resources are opened later, so they must close first — reversing
		// is what makes a nested open/close pair unwind correctly.
		const ext = fakeExtension();
		const order: string[] = [];
		registerEffect(ext, () => {
			order.push("outer");
		});
		registerEffect(ext, () => {
			order.push("inner");
		});
		await disposePluginPrimitives(ext);
		expect(order).toEqual(["inner", "outer"]);
	});

	test("a throwing cleanup does not stop the others", async () => {
		// One broken cleanup must not strand the rest: that is how a leak becomes
		// invisible rather than merely present.
		const ext = fakeExtension();
		const order: string[] = [];
		registerEffect(ext, () => {
			order.push("first");
		});
		registerEffect(ext, () => {
			throw new Error("boom");
		});
		registerEffect(ext, () => {
			order.push("last");
		});
		const ran = await disposePluginPrimitives(ext);
		// The thrower is not counted as ran; both neighbours are.
		expect(ran).toBe(2);
		expect(order).toEqual(["last", "first"]);
	});

	test("an async cleanup is awaited", async () => {
		// A cleanup that closes a socket asynchronously must finish before the
		// plugin is considered gone, or the next mount races it.
		const ext = fakeExtension();
		let done = false;
		registerEffect(ext, async () => {
			await Bun.sleep(5);
			done = true;
		});
		await disposePluginPrimitives(ext);
		expect(done).toBe(true);
	});

	test("a rejected async cleanup is isolated too", async () => {
		const ext = fakeExtension();
		const order: string[] = [];
		registerEffect(ext, async () => {
			order.push("a");
		});
		registerEffect(ext, async () => {
			await Bun.sleep(1);
			throw new Error("async boom");
		});
		const ran = await disposePluginPrimitives(ext);
		expect(ran).toBe(1);
		expect(order).toEqual(["a"]);
	});

	test("a plugin with no effects disposes cleanly", async () => {
		// The common case: most plugins register nothing, and that must not be
		// an error path.
		expect(await disposePluginPrimitives(fakeExtension())).toBe(0);
	});
});

describe("plugin state", () => {
	test("set then get round-trips", async () => {
		const ext = fakeExtension();
		stateSet(ext, "token", "abc");
		expect(stateGet<string>(ext, "token")).toBe("abc");
	});

	test("an unset key reads as undefined and has=false", async () => {
		const ext = fakeExtension();
		expect(stateGet(ext, "nope")).toBeUndefined();
		expect(stateHas(ext, "nope")).toBe(false);
	});

	test("has distinguishes an explicitly-set undefined", async () => {
		// "never set" and "set to undefined" are different questions, and a
		// plugin that caches a failed lookup needs to tell them apart.
		const ext = fakeExtension();
		stateSet(ext, "maybe", undefined);
		expect(stateGet(ext, "maybe")).toBeUndefined();
		expect(stateHas(ext, "maybe")).toBe(true);
	});

	test("two plugin instances do not share state", async () => {
		// THIS is the module-variable bug: the session loader and the ext.call
		// compiler hold separate instances, and state split across them made a
		// plugin read `null` through its own RPC.
		const a = fakeExtension();
		const b = fakeExtension();
		stateSet(a, "who", "a");
		expect(stateGet(b, "who")).toBeUndefined();
	});

	test("dispose clears state", async () => {
		// A reloaded plugin must not inherit its previous life's values.
		const ext = fakeExtension();
		stateSet(ext, "k", 1);
		await disposePluginPrimitives(ext);
		expect(stateHas(ext, "k")).toBe(false);
		expect(stateKeys(ext)).toEqual([]);
	});

	test("state outlives the cleanups so a cleanup can read it", async () => {
		// A cleanup that flushes what the plugin accumulated is the normal case,
		// so the state must still be there while cleanups run.
		const ext = fakeExtension();
		let seen: unknown;
		stateSet(ext, "buffer", [1, 2]);
		registerEffect(ext, () => {
			seen = stateGet(ext, "buffer");
		});
		await disposePluginPrimitives(ext);
		expect(seen).toEqual([1, 2]);
		// …and is gone afterwards.
		expect(stateHas(ext, "buffer")).toBe(false);
	});

	test("delete removes one key and reports whether it existed", async () => {
		const ext = fakeExtension();
		stateSet(ext, "a", 1);
		expect(stateDelete(ext, "a")).toBe(true);
		expect(stateDelete(ext, "a")).toBe(false);
		expect(stateHas(ext, "a")).toBe(false);
	});

	test("keys() is a copy — mutating it does not touch the plugin's state", async () => {
		// A plugin iterating its own keys must not be able to corrupt them.
		const ext = fakeExtension();
		stateSet(ext, "a", 1);
		const keys = stateKeys(ext);
		keys.push("injected");
		expect(stateHas(ext, "injected")).toBe(false);
	});
});

describe("failed mount cleanup", () => {
	test("a failed mount drops state without running cleanups", async () => {
		// A plugin that threw never registered cleanups (nothing ran past the
		// throw), but it may have written state first. That data is meaningless
		// and must not outlive the attempt — while nothing is executed, because
		// running a half-initialized cleanup is worse than leaking it.
		const ext = fakeExtension();
		let ran = 0;
		registerEffect(ext, () => {
			ran += 1;
		});
		stateSet(ext, "partial", true);

		disposeFailedPluginPrimitives(ext);

		expect(ran).toBe(0);
		expect(stateHas(ext, "partial")).toBe(false);
		// The dropped effect is gone, so a later dispose also runs nothing.
		expect(pendingEffectCount(ext)).toBe(0);
	});
});
