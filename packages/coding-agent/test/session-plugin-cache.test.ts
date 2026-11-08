/**
 * `loadSessionPluginsCached` — one plugin instance set per `(cwd, entry set)`.
 *
 * dsh mounts a preset once and lets its sessions join the scope; the equivalent
 * here is the workspace pair, because a plugin instance captures `cwd` at apply
 * time. Session-bound work (listeners, prompt contributions, effects) lives on
 * the session scope, so reuse does not leak between sessions.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ExtensionRunner,
	emitSessionShutdownEvent,
	emitSessionStartEvent,
} from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import {
	clearSessionPluginCache,
	loadSessionPluginsCached,
	retireSessionPluginGeneration,
	sessionPluginCacheKey,
} from "@musepi/pi-coding-agent/extensibility/plugins/runtime/session-loader";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

describe("session plugin cache", () => {
	it("reuses one load for the same cwd and entry set", async () => {
		const dir = TempDir.createSync("@session-cache-");
		const entry = path.join(dir.path(), "ext.ts");
		fs.writeFileSync(entry, 'export default function (pi: any) { pi.setLabel("cached"); }');
		clearSessionPluginCache();

		const { result: first } = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		const { result: second } = await loadSessionPluginsCached([entry], dir.path(), new EventBus());

		expect(second.runtime).toBe(first.runtime);
		expect(second.extensions[0]).toBe(first.extensions[0]);
		dir.removeSync();
	});

	it("keys a different cwd separately: plugins capture cwd at apply", async () => {
		const dir = TempDir.createSync("@session-cache-cwd-");
		const entry = path.join(dir.path(), "ext.ts");
		fs.writeFileSync(entry, 'export default function (pi: any) { pi.setLabel("cwd"); }');
		const other = path.join(dir.path(), "other");
		fs.mkdirSync(other);
		clearSessionPluginCache();

		const { result: first } = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		const { result: second } = await loadSessionPluginsCached([entry], other, new EventBus());

		expect(sessionPluginCacheKey([entry], dir.path())).not.toBe(sessionPluginCacheKey([entry], other));
		expect(second.runtime).not.toBe(first.runtime);
		dir.removeSync();
	});

	it("reuses the instance set while each session keeps its own prompt contributions", async () => {
		const dir = TempDir.createSync("@session-cache-prompt-");
		const entry = path.join(dir.path(), "prompt-ext.ts");
		fs.writeFileSync(
			entry,
			`export default function (pi: any) {
				pi.on("session_start", () => {
					pi.promptHost?.registerSection({ name: "cached-section", order: 5, text: "session-scoped-section" });
				});
			}`,
		);
		clearSessionPluginCache();

		const { result: load } = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		const extension = load.extensions[0]!;
		const hostA = new PromptHost({ owner: "session" });
		const hostB = new PromptHost({ owner: "session" });
		const runnerA = new ExtensionRunner(
			[extension],
			load.runtime,
			dir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		runnerA.setPromptHost(hostA);
		const runnerB = new ExtensionRunner(
			[extension],
			load.runtime,
			dir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		runnerB.setPromptHost(hostB);

		await emitSessionStartEvent(runnerA);
		await emitSessionStartEvent(runnerB);
		const hasSection = (host: PromptHost): boolean =>
			host.assemble().sections.some(section => section.text.includes("session-scoped-section"));
		expect(hasSection(hostA)).toBe(true);
		expect(hasSection(hostB)).toBe(true);

		// A's session ending must not remove B's contribution: the instance is
		// shared, the prompt host is not.
		await emitSessionShutdownEvent(runnerA);
		expect(hasSection(hostB)).toBe(true);
		dir.removeSync();
	});

	it("keeps a retired generation for its users and disposes it after the last release", async () => {
		const dir = TempDir.createSync("@session-cache-gen-");
		const entry = path.join(dir.path(), "ext.ts");
		fs.writeFileSync(
			entry,
			`export default function (pi: any) {
				pi.effect(() => { (globalThis as any).__cacheGenDisposed = true; });
			}`,
		);
		(globalThis as any).__cacheGenDisposed = false;
		clearSessionPluginCache();

		const first = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		const second = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		retireSessionPluginGeneration(first.result.extensions[0]!);

		first.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(Boolean((globalThis as any).__cacheGenDisposed)).toBe(false);

		second.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(Boolean((globalThis as any).__cacheGenDisposed)).toBe(true);
		dir.removeSync();
	});

	it("bypasses the cache for a fresh load", async () => {
		const dir = TempDir.createSync("@session-cache-fresh-");
		const entry = path.join(dir.path(), "ext.ts");
		fs.writeFileSync(entry, 'export default function (pi: any) { pi.setLabel("fresh"); }');
		clearSessionPluginCache();

		const { result: first } = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		const { result: second } = await loadSessionPluginsCached([entry], dir.path(), new EventBus(), { fresh: true });

		expect(second.runtime).not.toBe(first.runtime);
		expect(second.extensions[0]).not.toBe(first.extensions[0]);
		dir.removeSync();
	});
});
