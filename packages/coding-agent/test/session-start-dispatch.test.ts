/**
 * `session_start` dispatch contract.
 *
 * The event EXISTED in the type union and `pi.on("session_start", …)`
 * type-checked, but nothing ever dispatched it. That failure mode is silent —
 * no error, no log, the handler just never runs — so a plugin that relied on it
 * (to capture the `ExtensionContext`, which is the only way an extension can
 * reach `modelRegistry`) appeared to work until a turn happened to fire a tool
 * event. These tests pin the dispatch so the gap cannot reopen.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner, emitSessionStartEvent } from "../src/extensibility/extensions/runner";

/** An extension whose `session_start` handler records that it ran. */
async function extensionRecordingStart(): Promise<{ entry: string; dir: string; hits: () => number }> {
	const dir = await mkdtemp(path.join(tmpdir(), "ext-session-start-"));
	const entry = path.join(dir, "index.ts");
	await writeFile(
		entry,
		`const box = ((globalThis as any).__extSessionStart ??= { hits: 0 });
export default function (pi: any): void {
	pi.on("session_start", () => { box.hits += 1; });
}
`,
	);
	(globalThis as { __extSessionStart?: { hits: number } }).__extSessionStart = { hits: 0 };
	return {
		entry,
		dir,
		hits: () => (globalThis as { __extSessionStart?: { hits: number } }).__extSessionStart?.hits ?? 0,
	};
}

/** Build a runner bound to the extension set (no session needed for dispatch).
 *
 *  `emit` builds a real `ExtensionContext` for each handler, so the stubs must
 *  answer the few members the context reads lazily (`getCwd` is hit while
 *  building `cwd`). Stubbing them is what makes this a dispatch test rather
 *  than a context-shape test. */
async function runnerFor(entry: string): Promise<ExtensionRunner> {
	const result = await loadExtensions([entry], process.cwd());
	expect(result.errors).toEqual([]);
	const sessionManagerStub = {
		getCwd: () => process.cwd(),
		getAdditionalDirectories: () => [],
		getSessionFile: () => undefined,
		getSessionId: () => "test-session",
	} as never;
	const modelRegistryStub = {
		getApiKey: async () => undefined,
		getApiKeyForProvider: async () => undefined,
		getProviderLabel: () => undefined,
		authStorage: { listStoredCredentials: () => [] },
	} as never;
	return new ExtensionRunner(
		result.extensions,
		result.runtime,
		process.cwd(),
		sessionManagerStub,
		modelRegistryStub,
		() => undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	) as ExtensionRunner;
}

describe("emitSessionStartEvent", () => {
	test("dispatches session_start to an extension handler", async () => {
		// The whole point: the handler must actually RUN. Before the host emitted
		// this event, a plugin's context capture silently never happened.
		const ext = await extensionRecordingStart();
		try {
			const runner = await runnerFor(ext.entry);
			expect(ext.hits()).toBe(0);
			const dispatched = await emitSessionStartEvent(runner);
			expect(dispatched).toBe(true);
			expect(ext.hits()).toBe(1);
		} finally {
			delete (globalThis as { __extSessionStart?: { hits: number } }).__extSessionStart;
			await rm(ext.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("reports false when no extension subscribed", async () => {
		// A session with no interested plugin must not pay for a dispatch; the
		// boolean is what tells the caller whether anything ran.
		const dir = await mkdtemp(path.join(tmpdir(), "ext-no-handler-"));
		const entry = path.join(dir, "index.ts");
		await writeFile(entry, `export default function (pi: any): void { void pi; }\n`);
		try {
			const runner = await runnerFor(entry);
			expect(await emitSessionStartEvent(runner)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a session-less runner (undefined) is a no-op, not a crash", async () => {
		// Print mode and subagents build sessions without an extension runner;
		// construction must not fail on that path.
		expect(await emitSessionStartEvent(undefined)).toBe(false);
	});

	test("a throwing handler does not break session construction", async () => {
		// Starting a session must never depend on an extension behaving. The
		// throw is swallowed into a log; the other handlers still run.
		const dir = await mkdtemp(path.join(tmpdir(), "ext-throwing-"));
		const entry = path.join(dir, "index.ts");
		await writeFile(
			entry,
			`const box = ((globalThis as any).__extThrowing ??= { later: 0 });
export default function (pi: any): void {
	pi.on("session_start", () => { throw new Error("boom"); });
	pi.on("session_start", () => { box.later += 1; });
}
`,
		);
		(globalThis as { __extThrowing?: { later: number } }).__extThrowing = { later: 0 };
		try {
			const runner = await runnerFor(entry);
			// Must resolve, not reject.
			await emitSessionStartEvent(runner);
			const later = (globalThis as { __extThrowing?: { later: number } }).__extThrowing?.later ?? 0;
			// The sibling handler still ran (isolation, not abort-on-first-throw).
			expect(later).toBe(1);
		} finally {
			delete (globalThis as { __extThrowing?: { later: number } }).__extThrowing;
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
