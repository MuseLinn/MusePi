import { describe, expect, it } from "bun:test";
import { PluginInstallMachine } from "./plugin-install-machine";
import type { InstalledPlugin } from "./types";

/**
 * The machine is the part of plugin install a person actually interacts with
 * when something goes wrong: it decides whether a stopped run reads as a
 * cancellation or as a failure, refuses a second run that would race the first,
 * and carries the capability verdict from the install to the view.
 *
 * A stub manager stands in for `PluginManager` so each case can decide how the
 * install ends without a package manager, a plugins directory, or a network.
 */
function stubPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
	return {
		name: "acme-plugin",
		version: "1.0.0",
		path: "",
		manifest: { version: "1.0.0" },
		enabledFeatures: null,
		enabled: true,
		...overrides,
	};
}

interface StubBehaviour {
	/** Output chunks emitted before the install settles. */
	emit?: string[];
	/** Resolves the install, or rejects it. */
	settle?: (resolve: (plugin: InstalledPlugin) => void, reject: (err: Error) => void) => void;
	/** Whether the install rejects with the cancellation error on abort. */
	abortsAsCancelled?: boolean;
}

function stubManager(behaviour: StubBehaviour = {}) {
	const calls: { spec: string; signals: AbortSignal[] }[] = [];
	const manager = {
		async install(
			spec: string,
			options: { signal?: AbortSignal; onOutput?: (c: { stream: "stdout" | "stderr"; text: string }) => void } = {},
		) {
			calls.push({ spec, signals: [options.signal as AbortSignal] });
			for (const text of behaviour.emit ?? []) options.onOutput?.({ stream: "stdout", text });
			return new Promise<InstalledPlugin>((resolve, reject) => {
				const finish = behaviour.settle ?? ((res: (p: InstalledPlugin) => void) => res(stubPlugin()));
				const onAbort = (): void => {
					if (behaviour.abortsAsCancelled) reject(new Error("plugin install cancelled"));
				};
				options.signal?.addEventListener("abort", onAbort, { once: true });
				finish(resolve, reject);
			});
		},
		async uninstall(): Promise<void> {},
	} as unknown as ConstructorParameters<typeof PluginInstallMachine>[0];
	return { manager, calls };
}

/** Settle every pending microtask so the machine reaches its terminal state. */
async function drain(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("PluginInstallMachine", () => {
	it("refuses a second install of the same spec while the first is live", async () => {
		// Two runs would race on one plugins/package.json, and the loser's
		// rollback would restore a manifest the winner already moved past.
		const { manager } = stubManager();
		const machine = new PluginInstallMachine(manager);
		machine.start({ spec: "acme-plugin" });
		expect(() => machine.start({ spec: "acme-plugin" })).toThrow(/already installing/);
		// A different spec is a different package and must not be blocked.
		expect(() => machine.start({ spec: "other-plugin" })).not.toThrow();
	});

	it("refuses a spec it cannot classify before registering a run", () => {
		// A malformed spec is refused at the call rather than becoming a failed
		// install the person has to read through.
		const { manager, calls } = stubManager();
		const machine = new PluginInstallMachine(manager);
		expect(() => machine.start({ spec: "Not A Package" })).toThrow(/registry accepts/);
		expect(calls).toHaveLength(0);
		expect(machine.status().installs).toHaveLength(0);
	});

	it("reports a person-initiated stop as cancelled, not as a failure", async () => {
		const { manager } = stubManager({
			abortsAsCancelled: true,
			settle: (_resolve, reject) => {
				// The install only ends when the machine aborts it.
			},
		});
		const states: string[] = [];
		const machine = new PluginInstallMachine(manager, view => states.push(view.state));
		const installId = machine.start({ spec: "acme-plugin" });
		await drain();

		expect(machine.cancel(installId)).toEqual({ status: "cancelled" });
		await drain();

		const view = machine.status().installs.find(v => v.installId === installId);
		expect(view?.state).toBe("cancelled");
		// The distinction the GUI renders from: a cancellation is not an error,
		// so it must not carry a failure classification.
		expect(view?.kind).toBeUndefined();
		expect(states.at(-1)).toBe("cancelled");
	});

	it("answers a cancel for an unknown or finished install as not-running", async () => {
		const { manager } = stubManager();
		const machine = new PluginInstallMachine(manager);
		const installId = machine.start({ spec: "acme-plugin" });
		await drain();

		// A second cancel for the same id, and an id this machine never issued,
		// are both no-ops rather than errors: a double click must not fail.
		expect(machine.cancel(installId)).toEqual({ status: "not-running" });
		expect(machine.cancel("not-a-real-id")).toEqual({ status: "not-running" });
	});

	it("classifies a package-manager refusal as an install failure, keeping its message", async () => {
		const { manager } = stubManager({
			settle: (_resolve, reject) => {
				reject(new Error("bun install failed: ENOTFOUND registry.example"));
			},
		});
		const machine = new PluginInstallMachine(manager);
		const installId = machine.start({ spec: "acme-plugin" });
		await drain();

		const view = machine.status().installs.find(v => v.installId === installId);
		expect(view?.state).toBe("failed");
		// A network failure is retryable, so it is classified apart from a spec
		// error, and the reason survives for the person to read.
		expect(view?.kind).toBe("install");
		expect(view?.message).toContain("ENOTFOUND");
	});

	it("retains the package manager's output under the install's own id", async () => {
		const { manager } = stubManager({ emit: ["resolving dependencies\n", "added 1 package\n"] });
		const lines: { installId: string; text: string }[] = [];
		const machine = new PluginInstallMachine(manager, undefined, line =>
			lines.push({ installId: line.installId, text: line.text }),
		);
		const installId = machine.start({ spec: "acme-plugin" });
		await drain();

		// Output must be attributable to the run that produced it; the GUI
		// filters on the id it owns.
		expect(lines.every(l => l.installId === installId)).toBe(true);
		expect(machine.output(installId).map(l => l.text)).toEqual(["resolving dependencies\n", "added 1 package\n"]);
		// An id this machine never issued reads empty rather than failing.
		expect(machine.output("not-a-real-id")).toEqual([]);
	});
});
