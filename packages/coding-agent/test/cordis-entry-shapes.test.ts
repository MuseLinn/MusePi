/**
 * Plugin entry shapes — what a module may export as a plugin.
 *
 * Upstream plugins are written as CLASSES (`class X extends Service { static
 * inject; constructor(ctx) { super(ctx, 'x') } }`), which is a different calling
 * convention from the object-with-`apply` shape. Getting this wrong is not a
 * type error at load time: the loader CALLS the class, the class throws
 * "cannot be invoked without 'new'", and the plugin never runs. So both the
 * calling convention and the declared-dependency reading are pinned here.
 */

import { describe, expect, test } from "bun:test";
import {
	declaredInject,
	declaredProvide,
	entryName,
	isBareFactory,
	isConstructorPlugin,
	isCordisPluginEntry,
	missingServiceDependencies,
	providedServices,
	resolvePluginEntry,
	toFactory,
} from "../src/extensibility/plugins/runtime/cordis-entry";

describe("calling convention", () => {
	test("a class entry is constructed, not called", () => {
		// The upstream default shape. Calling it throws before any code runs, so
		// this is the difference between "plugin loads" and "plugin never runs".
		const seen: unknown[] = [];
		class ClassPlugin {
			constructor(ctx: unknown, config?: unknown) {
				seen.push([ctx, config]);
			}
		}
		const factory = toFactory(ClassPlugin as never);
		factory({ id: "ctx" } as never, { k: 1 });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual([{ id: "ctx" }, { k: 1 }]);
	});

	test("an arrow-function entry is called, not constructed", () => {
		// The legacy factory shape. Constructing it would throw ("not a
		// constructor"), so the distinction has to hold in both directions.
		let called: unknown;
		const arrow = ((ctx: unknown) => {
			called = ctx;
		}) as never;
		expect(isConstructorPlugin(arrow)).toBe(false);
		toFactory(arrow)({ id: "ctx" } as never);
		expect(called).toEqual({ id: "ctx" });
	});

	test("a plain function is constructed, matching the runtime's rule", () => {
		// CORDIS decides with `prototype` presence, so a plain `function` counts
		// as a constructor. Mirroring that rule is what keeps a plugin's shape
		// meaning the same thing here as in the runtime it targets.
		function PlainFunction(this: unknown) {}
		expect(isConstructorPlugin(PlainFunction as never)).toBe(true);
	});

	test("a generator function is called, not constructed", () => {
		// Cordis-plugin-include uses generator plugins; a generator has a
		// prototype but is not a constructor.
		function* generator() {
			yield undefined;
		}
		expect(isConstructorPlugin(generator as never)).toBe(false);
	});

	test("an object entry routes to its apply", () => {
		const calls: unknown[] = [];
		const entry = {
			apply: (ctx: unknown, config?: unknown) => {
				calls.push([ctx, config]);
			},
		};
		toFactory(entry)({ id: "ctx" } as never, { k: 2 });
		expect(calls).toEqual([[{ id: "ctx" }, { k: 2 }]]);
	});
});

describe("declared dependencies, either shape", () => {
	test("a class carries them on static inject", () => {
		// A class cannot have an instance field before construction, so the
		// upstream convention is `static inject`. Reading only the object shape
		// made a class plugin's dependencies invisible: the gate let it mount and
		// it failed later on first use instead of being refused at load.
		class NeedsServices {
			static inject = ["credentials", "llm"];
			readonly api: unknown;
			constructor(api: unknown) {
				this.api = api;
			}
		}
		expect(declaredInject(NeedsServices as never)).toEqual(["credentials", "llm"]);
		expect(missingServiceDependencies(NeedsServices as never)).toEqual([]);
	});

	test("a class's unsatisfiable dependency is refused", () => {
		class NeedsNobodyProvides {
			static inject = ["no-such-service"];
			readonly api: unknown;
			constructor(api: unknown) {
				this.api = api;
			}
		}
		expect(missingServiceDependencies(NeedsNobodyProvides as never)).toEqual(["no-such-service"]);
	});

	test("a class's static provide is read", () => {
		class Provides {
			static provide = ["mine.thing"];
			readonly api: unknown;
			constructor(api: unknown) {
				this.api = api;
			}
		}
		expect(providedServices(Provides as never)).toEqual(["mine.thing"]);
		expect(declaredProvide(Provides as never)).toEqual(["mine.thing"]);
	});

	test("an entry with no declaration reads as empty, not as an error", () => {
		const arrow = (() => {}) as never;
		expect(declaredInject(arrow)).toEqual([]);
		expect(declaredProvide(arrow)).toEqual([]);
		expect(declaredInject(null)).toEqual([]);
	});
});

describe("module shape resolution", () => {
	test("a default-exported class resolves as the entry", () => {
		// `export default class X` arrives as `{ default: X }`; the wrapper has to
		// be unwrapped or the loader sees a module object with no plugin in it.
		class DefaultClass {}
		expect(resolvePluginEntry({ default: DefaultClass } as never)).toBe(DefaultClass as never);
	});

	test("a default-exported object entry resolves as the entry", () => {
		const entry = { name: "x", apply: () => {} };
		expect(resolvePluginEntry({ default: entry } as never)).toBe(entry as never);
	});

	test("an empty module resolves to null, not to a thrown error", () => {
		// One malformed plugin must not take down the rest of the set.
		expect(resolvePluginEntry({} as never)).toBeNull();
	});

	test("entryName falls back to the path-derived name for a class", () => {
		// A class's `name` is its identifier, which is not a stable plugin name;
		// the caller's fallback (path-derived) is the identity.
		class SomeClass {}
		expect(entryName(SomeClass as never, "from-path")).toBe("from-path");
		expect(entryName({ name: "declared", apply: () => {} }, "from-path")).toBe("declared");
	});

	test("the shape predicates agree with the dispatch", () => {
		// The loader picks a branch from these, so a value that reads as both or
		// neither would dispatch wrongly.
		class C {}
		const obj = { apply: () => {} };
		expect(isBareFactory(C as never)).toBe(true);
		expect(isCordisPluginEntry(C as never)).toBe(false);
		expect(isBareFactory(obj as never)).toBe(false);
		expect(isCordisPluginEntry(obj as never)).toBe(true);
	});
});
