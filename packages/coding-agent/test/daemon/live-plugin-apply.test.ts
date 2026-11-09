import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	applyPackageChange,
	applyPluginChangeToSessions,
	type LiveApplySession,
} from "../../src/daemon/live-plugin-apply";

interface Call {
	readonly id: string;
	readonly op: "load" | "reload" | "unload";
	readonly entryPath: string;
}

/**
 * A session that records calls and answers with the timing the caller asked
 * for. `parked` models a streaming session: every op reports deferred.
 */
function fakeSession(options: {
	id?: string;
	loaded?: string[];
	parked?: boolean;
	failOn?: string;
	errorText?: string;
}): { session: LiveApplySession; calls: Call[] } {
	const loaded = new Set((options.loaded ?? []).map(entry => path.resolve(entry)));
	const calls: Call[] = [];
	const record = async (op: Call["op"], entryPath: string) => {
		const resolved = path.resolve(entryPath);
		calls.push({ id: options.id ?? "s", op, entryPath: resolved });
		if (options.failOn && path.resolve(options.failOn) === resolved) {
			return { errors: [options.errorText ?? "boom"], deferred: false };
		}
		if (op === "load") loaded.add(resolved);
		if (op === "unload") loaded.delete(resolved);
		return { errors: [] as string[], deferred: options.parked ?? false };
	};
	const session: LiveApplySession = {
		sessionId: options.id,
		listLoadedExtensions: () => [...loaded].map(entry => ({ path: entry })),
		loadExtension: entry => record("load", entry),
		reloadExtension: entry => record("reload", entry),
		unloadExtension: entry => record("unload", entry),
	};
	return { session, calls };
}

describe("applyPluginChangeToSessions", () => {
	test("loads new entries and reloads entries the session already mounted", async () => {
		const a = "/plugins/pkg/a.ts";
		const b = "/plugins/pkg/b.ts";
		const { session, calls } = fakeSession({ loaded: [a] });

		const summary = await applyPluginChangeToSessions([session], { add: [a, b] });

		expect(calls.map(call => [path.basename(call.entryPath), call.op])).toEqual([
			["a.ts", "reload"],
			["b.ts", "load"],
		]);
		expect(summary).toEqual({ sessions: 1, applied: 2, deferred: 0, errors: [] });
	});

	test("unload only touches entries the session actually has", async () => {
		const a = "/plugins/pkg/a.ts";
		const b = "/plugins/pkg/b.ts";
		const { session, calls } = fakeSession({ loaded: [a] });

		const summary = await applyPluginChangeToSessions([session], { remove: [a, b] });

		expect(calls.map(call => call.op)).toEqual(["unload"]);
		expect(summary.applied).toBe(1);
	});

	test("a streaming session is counted as deferred, not applied", async () => {
		const { session } = fakeSession({ loaded: [], parked: true });

		const summary = await applyPluginChangeToSessions([session], { add: ["/plugins/pkg/a.ts"] });

		expect(summary).toEqual({ sessions: 1, applied: 0, deferred: 1, errors: [] });
	});

	test("one session's failure does not stop another session", async () => {
		const bad = fakeSession({ id: "bad", failOn: "/plugins/pkg/a.ts" });
		const good = fakeSession({ id: "good" });

		const summary = await applyPluginChangeToSessions([bad.session, good.session], {
			add: ["/plugins/pkg/a.ts"],
		});

		expect(summary.sessions).toBe(2);
		expect(summary.applied).toBe(1);
		expect(summary.errors).toHaveLength(1);
		expect(summary.errors[0]).toContain("[bad]");
		expect(summary.errors[0]).toContain("boom");
		expect(good.calls).toHaveLength(1);
	});

	test("a session with nothing applicable is not counted", async () => {
		const { session, calls } = fakeSession({ loaded: [] });

		const summary = await applyPluginChangeToSessions([session], { remove: ["/plugins/pkg/a.ts"] });

		expect(calls).toHaveLength(0);
		expect(summary.sessions).toBe(0);
	});
});

describe("applyPackageChange", () => {
	test("resolves the package, applies, and announces the outcome", async () => {
		const applied: Array<Record<string, unknown>> = [];
		const { session } = fakeSession({ loaded: [] });

		const summary = await applyPackageChange(
			{
				resolvePackagePaths: async name => [`/plugins/${name}/index.ts`],
				applyLive: target => applyPluginChangeToSessions([session], target),
				onApplyState: payload => applied.push(payload),
			},
			"install",
			"pkg",
		);

		expect(summary?.applied).toBe(1);
		expect(applied).toHaveLength(1);
		expect(applied[0]).toMatchObject({
			type: "plugins.apply.state",
			change: "install",
			packageName: "pkg",
			application: "applied",
			applied: 1,
			deferred: 0,
			errors: [],
		});
	});

	test("reports pending when a session had to park the change", async () => {
		const applied: Array<Record<string, unknown>> = [];
		const entry = "/plugins/pkg/index.ts";
		const { session } = fakeSession({ loaded: [entry], parked: true });

		await applyPackageChange(
			{
				resolvePackagePaths: async () => [entry],
				applyLive: target => applyPluginChangeToSessions([session], target),
				onApplyState: payload => applied.push(payload),
			},
			"uninstall",
			"pkg",
		);

		expect(applied[0]).toMatchObject({ change: "uninstall", application: "pending", deferred: 1 });
	});

	test("announces nothing when no open session had anything to do", async () => {
		const applied: Array<Record<string, unknown>> = [];
		const { session } = fakeSession({ loaded: [] });

		const summary = await applyPackageChange(
			{
				resolvePackagePaths: async () => ["/plugins/pkg/index.ts"],
				applyLive: target => applyPluginChangeToSessions([session], target),
				onApplyState: payload => applied.push(payload),
			},
			"uninstall",
			"pkg",
		);

		expect(summary).toEqual({ sessions: 0, applied: 0, deferred: 0, errors: [] });
		expect(applied).toHaveLength(0);
	});

	test("a package with no entries is not an error and announces nothing", async () => {
		const applied: Array<Record<string, unknown>> = [];
		const summary = await applyPackageChange(
			{
				resolvePackagePaths: async () => [],
				applyLive: async () => ({ sessions: 0, applied: 0, deferred: 0, errors: [] }),
				onApplyState: payload => applied.push(payload),
			},
			"install",
			"pkg",
		);

		expect(summary).toBeUndefined();
		expect(applied).toHaveLength(0);
	});

	test("a resolve failure is announced as an apply error, not thrown", async () => {
		const applied: Array<Record<string, unknown>> = [];
		const summary = await applyPackageChange(
			{
				resolvePackagePaths: async () => {
					throw new Error("inventory unreadable");
				},
				applyLive: async () => ({ sessions: 0, applied: 0, deferred: 0, errors: [] }),
				onApplyState: payload => applied.push(payload),
			},
			"install",
			"pkg",
		);

		expect(summary?.errors).toEqual(["inventory unreadable"]);
		expect(applied[0]).toMatchObject({ errors: ["inventory unreadable"] });
	});

	test("a host without a live surface is a no-op", async () => {
		const summary = await applyPackageChange({}, "install", "pkg");
		expect(summary).toBeUndefined();
	});
});
