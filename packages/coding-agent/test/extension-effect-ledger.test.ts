/**
 * `ctx.effect` is the one cleanup ledger for every tracked plugin: the same
 * record is drained by the cordis mount, the bundled host loader's reset, and
 * (for session extensions) the runner's teardown.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBundledPluginLoader } from "../src/bundled-plugins/loader";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { disposePluginPrimitives } from "../src/extensibility/plugins/runtime/cordis-primitives";
import { EventBus } from "../src/utils/event-bus";

function inlineRuntime(): ExtensionRuntime {
	return new ExtensionRuntime();
}

describe("extension effect ledger", () => {
	it("runs cleanups in reverse order when the plugin is disposed", async () => {
		const ran: string[] = [];
		const extension = await loadExtensionFromFactory(
			ctx => {
				ctx.effect(() => {
					ran.push("first");
				});
				ctx.effect(() => {
					ran.push("second");
				});
			},
			process.cwd(),
			new EventBus(),
			inlineRuntime(),
			"<effects>",
		);

		await disposePluginPrimitives(extension);
		expect(ran).toEqual(["second", "first"]);
	});

	it("removes one cleanup through the disposer without unloading the plugin", async () => {
		const ran: string[] = [];
		let off: (() => void) | undefined;
		const extension = await loadExtensionFromFactory(
			ctx => {
				off = ctx.effect(() => {
					ran.push("cancelled");
				});
				ctx.effect(() => {
					ran.push("kept");
				});
			},
			process.cwd(),
			new EventBus(),
			inlineRuntime(),
			"<effects>",
		);

		off?.();
		await disposePluginPrimitives(extension);
		expect(ran).toEqual(["kept"]);
	});

	it("drains a bundled host plugin's effects when its loader resets", async () => {
		const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-bundled-effects-"));
		const entry = path.join(fixture, "host-plugin", "index.ts");
		await fs.mkdir(path.dirname(entry), { recursive: true });
		await Bun.write(
			path.join(fixture, "host-plugin", "package.json"),
			JSON.stringify({ name: "host-plugin", musepi: { extensions: ["./index.ts"], scope: "host" } }),
		);
		await Bun.write(
			entry,
			`
			export const name = "host-plugin";
			export const inject = [];
			export function apply(ctx) {
				ctx.effect(() => {
					globalThis.__hostEffectRan = true;
				});
			}
			`,
		);
		const state = globalThis as typeof globalThis & { __hostEffectRan?: boolean };
		delete state.__hostEffectRan;

		try {
			const loader = createBundledPluginLoader(() => Promise.resolve([entry]));
			expect(await loader.ensure(fixture)).toBe(true);
			loader.reset();
			for (let attempt = 0; attempt < 50 && state.__hostEffectRan !== true; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			expect(state.__hostEffectRan === true).toBe(true);
		} finally {
			delete state.__hostEffectRan;
			await fs.rm(fixture, { recursive: true, force: true });
		}
	});
});
