/**
 * `ctx.session` — the per-session registration scope.
 *
 * dsh gives every agent a scoped context, so a listener wired when the agent is
 * created dies with it. MusePi's equivalent is the session: the runner opens
 * the scope before `session_start` and closes it at teardown. Without this, a
 * plugin that registers listeners in `session_start` either leaks them across
 * sessions or has to track every disposer itself.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExtensionRuntime, loadExtensionFromFactory } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import {
	ExtensionRunner,
	emitSessionShutdownEvent,
	emitSessionStartEvent,
} from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

describe("ctx.session", () => {
	let tempDir: TempDir;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-session-scope-case-");
		extensionsDir = path.join(tempDir.path(), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
	});

	const makeRunner = async (
		apply: (ctx: ExtensionAPI) => void,
	): Promise<{ runner: ExtensionRunner; extension: Extension }> => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => apply(pi),
			tempDir.path(),
			new EventBus(),
			runtime,
			path.join(extensionsDir, "session-scope.ts"),
		);
		// No model lookups in this file; the null registry keeps the fixture free
		// of a sqlite auth store (and its Windows file-lock flakes).
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		return { runner, extension };
	};

	it("is undefined outside a session", async () => {
		let seen: ExtensionAPI["session"];
		const { runner } = await makeRunner(pi => {
			seen = pi.session;
		});
		expect(seen).toBeUndefined();
		expect(runner.hasHandlers("agent_end")).toBe(false);
		tempDir.removeSync();
	});

	it("keeps a listener for the session it was wired in and drops it at teardown", async () => {
		let calls = 0;
		const { runner } = await makeRunner(pi => {
			pi.on("session_start", () => {
				pi.session?.on("agent_end", () => {
					calls += 1;
				});
			});
		});

		await emitSessionStartEvent(runner);
		await runner.emit({ type: "agent_end", messages: [] });
		expect(calls).toBe(1);

		await emitSessionShutdownEvent(runner);
		await runner.emit({ type: "agent_end", messages: [] });
		expect(calls).toBe(1);
		tempDir.removeSync();
	});

	it("re-registers instead of stacking when session_start is replayed", async () => {
		let calls = 0;
		const { runner } = await makeRunner(pi => {
			pi.on("session_start", () => {
				pi.session?.on("agent_end", () => {
					calls += 1;
				});
			});
		});

		await emitSessionStartEvent(runner);
		// `refreshSessionStart` after a plugin reload replays the event on the
		// same runner; the previous scope must not keep its listener.
		await emitSessionStartEvent(runner);
		await runner.emit({ type: "agent_end", messages: [] });

		expect(calls).toBe(1);
		tempDir.removeSync();
	});

	it("stops counting handlers once the session ends", async () => {
		const { runner } = await makeRunner(pi => {
			pi.on("session_start", () => {
				pi.session?.on("agent_end", () => {});
			});
		});

		await emitSessionStartEvent(runner);
		expect(runner.hasHandlers("agent_end")).toBe(true);

		await emitSessionShutdownEvent(runner);
		expect(runner.hasHandlers("agent_end")).toBe(false);
		tempDir.removeSync();
	});

	it("lets the listener be removed early, and a second dispose is a no-op", async () => {
		let calls = 0;
		let removeEarly: (() => void) | undefined;
		const { runner, extension } = await makeRunner(pi => {
			pi.on("session_start", () => {
				removeEarly = pi.session?.on("agent_end", () => {
					calls += 1;
				});
			});
		});

		await emitSessionStartEvent(runner);
		removeEarly?.();
		await runner.emit({ type: "agent_end", messages: [] });
		expect(calls).toBe(0);

		// Session close and extension unload both reach the same disposer; a
		// second pass must not decrement the listener count below zero.
		await emitSessionShutdownEvent(runner);
		const { disposePluginPrimitives } = await import(
			"@musepi/pi-coding-agent/extensibility/plugins/runtime/cordis-primitives"
		);
		await disposePluginPrimitives(extension);
		expect(runner.hasHandlers("agent_end")).toBe(false);
		tempDir.removeSync();
	});
});
