/**
 * Plugin install state machine: `plugins.install` as an observable, cancellable,
 * retryable operation rather than one blocking call.
 *
 * The shape follows the skills install machine (`skills/marketplace-install-machine.ts`)
 * rather than the plugin manager's own CLI path, so a person watching the GUI
 * sees the same vocabulary they already see for skills — and so both machines
 * can be reasoned about as one kind of thing.
 *
 * Stages and why each exists:
 *
 *   inspecting → installing → done
 *        ↘ failed{spec}        ↘ failed{scripts}      ↘ failed{install}
 *                                                    ↘ failed{unknown}
 *   any active stage → cancel → cancelled
 *
 * - `inspecting` classifies the spec and reads the package's declared surface
 *   before anything is written. A spec that cannot be classified fails here
 *   rather than after a package manager has already touched the plugins dir.
 * - `installing` delegates to `PluginManager.install`, which owns the manifest,
 *   lockfile, and node_modules rollback; a cancellation reaches it as an
 *   AbortSignal and comes back as `InstallAbortedError`.
 * - `done` carries the resolved package name and version, plus a capability
 *   report. The report is not decoration: a package can install successfully
 *   and still be unable to run, because "installs" and "runs" are separate
 *   questions (see `capability-report.ts`).
 *
 * There is no `awaiting-approval` stage here, and the reason is the package
 * manager rather than a design choice: `bun install <spec>` does not pass
 * `--trust`, and bun does not run a dependency's lifecycle scripts unless the
 * package appears in the project's `trustedDependencies`. A dragged-in archive
 * therefore cannot execute its own `preinstall`/`postinstall` at all — the
 * approval question that gates a skill package (whose install copies files the
 * loader then evaluates, and which this machine can intercept between download
 * and copy) has no analogue here. Adding a stage later would mean adding
 * `--trust`, which is a decision about what a plugin install may execute, not
 * about presenting one.
 */

import { logger } from "@musepi/pi-utils";
import { describePluginCapability, type PluginCapabilityReport } from "./capability-report";
import type { PluginManager } from "./manager";
import { type InstallSpecKind, InvalidInstallSpecError, parseInstallSpec } from "./spec-classifier";
import { InstallAbortedError, type InstalledPlugin, type InstallOutputChunk } from "./types";

export type PluginInstallState = "inspecting" | "installing" | "done" | "failed" | "cancelled";

/**
 * Why an install failed, classified so the GUI can offer the right next action
 * instead of showing every failure as the same red text.
 *
 * - `spec` — the spec itself is unusable; retrying it unchanged cannot help.
 * - `scripts` — the install was refused because the package declares executable
 *   scripts or install hooks; the person has to change the source, not retry.
 * - `install` — the package manager failed; retrying may well succeed.
 * - `unknown` — anything the machine could not attribute.
 */
export type PluginInstallFailureKind = "spec" | "scripts" | "install" | "unknown";

/** One output line attributed to an install, as the GUI transcript keeps it. */
export interface PluginInstallOutputLine {
	readonly installId: string;
	readonly stream: "stdout" | "stderr";
	readonly text: string;
	readonly at: number;
}

/** The external view: `plugins.install.status` and the state event carry this. */
export interface PluginInstallView {
	readonly installId: string;
	readonly spec: string;
	readonly specKind?: InstallSpecKind;
	readonly state: PluginInstallState;
	/** failed 时：语义分类。 */
	readonly kind?: PluginInstallFailureKind;
	/** failed 时：人类可读原因。 */
	readonly message?: string;
	/** done 时：解析出的包名。 */
	readonly name?: string;
	/** done 时：安装后的版本。 */
	readonly version?: string;
	/**
	 * done 时：这个插件在当前底座上能否运行。
	 *
	 * A separate field from `state` because the two answer different questions.
	 * `state: "done"` reports that the install completed; `capability` reports
	 * whether what was installed can actually load. They disagree whenever a
	 * package targets another harness's runtime, which is the common case for
	 * plugins shared between harnesses.
	 */
	readonly capability?: PluginCapabilityReport;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface PluginInstallStartParams {
	/** The spec as typed: a package name, a git source, a tarball, or a path. */
	readonly spec: string;
	/** Overwrite an existing entry of the same name. */
	readonly force?: boolean;
}

interface InstallRecord {
	readonly installId: string;
	readonly params: PluginInstallStartParams;
	readonly controller: AbortController;
	/** Replaced wholesale on every transition; a reader never holds a stale copy. */
	view: PluginInstallView;
	/** Whether a stop was asked for. The signal, not this flag, is the authority. */
	cancelRequested: boolean;
	state: PluginInstallState;
}

/** Terminal records kept for `status`, oldest trimmed beyond this. */
const TERMINAL_KEEP = 20;

/** How much output one install retains in its transcript. */
const OUTPUT_LINES_MAX = 2_000;

export class PluginInstallMachine {
	readonly #records = new Map<string, InstallRecord>();
	readonly #lines = new Map<string, PluginInstallOutputLine[]>();
	readonly #onState: ((view: PluginInstallView) => void) | null;
	readonly #onOutput: ((line: PluginInstallOutputLine) => void) | null;
	readonly #manager: PluginManager;

	constructor(
		manager: PluginManager,
		onState?: (view: PluginInstallView) => void,
		onOutput?: (line: PluginInstallOutputLine) => void,
	) {
		this.#manager = manager;
		this.#onState = onState ?? null;
		this.#onOutput = onOutput ?? null;
	}

	/**
	 * Begin an install.
	 *
	 * The spec is classified synchronously, so a malformed spec is refused by
	 * this call rather than becoming a failed install the person has to read
	 * through. Everything past that point is observable.
	 *
	 * @param params - the spec and whether to overwrite an existing entry.
	 * @returns the install id to poll or cancel.
	 * @throws {InvalidInstallSpecError} when the spec cannot be classified.
	 */
	start(params: PluginInstallStartParams): string {
		const spec = params.spec.trim();
		const classification = parseInstallSpec(spec);

		// Two live installs of the same spec would race on one plugins/package.json,
		// and the loser's rollback would restore a manifest the winner already
		// moved past.
		for (const rec of this.#records.values()) {
			if (!this.#isTerminal(rec) && rec.params.spec === spec) {
				throw new Error(`plugins.install: "${spec}" is already installing`);
			}
		}

		const installId = crypto.randomUUID();
		const now = Date.now();
		const record: InstallRecord = {
			installId,
			params: { ...params, spec },
			view: {
				installId,
				spec,
				specKind: classification.kind,
				state: "inspecting",
				startedAt: now,
				updatedAt: now,
			},
			controller: new AbortController(),
			cancelRequested: false,
			state: "inspecting",
		};
		this.#records.set(installId, record);
		this.#lines.set(installId, []);
		this.#pruneTerminal();
		void this.#run(record, classification).catch((err: unknown) => {
			// #run settles every failure itself; this guard catches only a bug in
			// the machine, which must not leave the record hanging in a live phase.
			logger.error("plugin install machine crashed", { installId, err });
			this.#settle(record, "failed", "unknown", err instanceof Error ? err.message : String(err));
		});
		return installId;
	}

	/**
	 * Ask a live install to stop.
	 *
	 * @param installId - the install to stop.
	 * @returns `cancelled` when the request was accepted (the terminal event
	 * follows), `not-running` when the id is unknown or already terminal.
	 */
	cancel(installId: string): { status: "cancelled" | "not-running" } {
		const rec = this.#records.get(installId);
		if (!rec || this.#isTerminal(rec)) return { status: "not-running" };
		rec.cancelRequested = true;
		rec.controller.abort();
		return { status: "cancelled" };
	}

	/**
	 * The status view: live installs first, then terminal records newest-first.
	 */
	status(): { installs: PluginInstallView[] } {
		const all = [...this.#records.values()];
		const live = all.filter(rec => !this.#isTerminal(rec));
		const terminal = all.filter(rec => this.#isTerminal(rec)).sort((a, b) => b.view.updatedAt - a.view.updatedAt);
		return { installs: [...live, ...terminal].map(rec => rec.view) };
	}

	/**
	 * The retained output for one install, in arrival order.
	 *
	 * @param installId - the install to read.
	 * @returns the lines, or an empty list for an id this machine never issued.
	 */
	output(installId: string): PluginInstallOutputLine[] {
		return this.#lines.get(installId) ?? [];
	}

	async #run(record: InstallRecord, classification: ReturnType<typeof parseInstallSpec>): Promise<void> {
		try {
			// A cancellation that arrived before the run started is not a
			// cancelled install — nothing ran — but it is still what the person
			// asked for, and reporting otherwise leaves a button that does nothing.
			if (record.controller.signal.aborted) {
				this.#settle(record, "cancelled");
				return;
			}

			const installed: InstalledPlugin = await this.#manager.install(record.params.spec, {
				force: record.params.force ?? false,
				signal: record.controller.signal,
				onOutput: (chunk: InstallOutputChunk) => this.#recordOutput(record, chunk),
			});

			if (record.controller.signal.aborted) {
				this.#settle(record, "cancelled");
				return;
			}

			// The install succeeded; whether the package can run here is a separate
			// question, answered after the fact so a runnable install is never
			// reported as a failure.
			const capability = await describePluginCapability(installed);
			this.#settle(record, "done", undefined, undefined, {
				name: installed.name,
				version: installed.version,
				capability,
			});
		} catch (err) {
			if (err instanceof InvalidInstallSpecError) {
				this.#settle(record, "failed", "spec", err.reason);
				return;
			}
			if (err instanceof InstallAbortedError || record.controller.signal.aborted) {
				this.#settle(record, "cancelled");
				return;
			}
			this.#settle(record, "failed", classifyInstallFailure(err), err instanceof Error ? err.message : String(err));
		}
	}

	#recordOutput(record: InstallRecord, chunk: InstallOutputChunk): void {
		const line: PluginInstallOutputLine = {
			installId: record.installId,
			stream: chunk.stream,
			text: chunk.text,
			at: Date.now(),
		};
		const lines = this.#lines.get(record.installId) ?? [];
		// A package manager that prints without newlines would otherwise grow this
		// without limit; the cap is on retained transcript, not on what was shown.
		if (lines.length >= OUTPUT_LINES_MAX) lines.splice(0, lines.length - OUTPUT_LINES_MAX + 1);
		lines.push(line);
		this.#lines.set(record.installId, lines);
		this.#onOutput?.(line);
	}

	#settle(
		record: InstallRecord,
		state: PluginInstallState,
		kind?: PluginInstallFailureKind,
		message?: string,
		done?: { name: string; version: string; capability: PluginCapabilityReport },
	): void {
		record.state = state;
		record.view = {
			...record.view,
			state,
			...(kind !== undefined ? { kind } : {}),
			...(message !== undefined ? { message } : {}),
			...(done !== undefined ? { name: done.name, version: done.version, capability: done.capability } : {}),
			updatedAt: Date.now(),
		};
		this.#onState?.(record.view);
	}

	#isTerminal(record: InstallRecord): boolean {
		return record.state === "done" || record.state === "failed" || record.state === "cancelled";
	}

	#pruneTerminal(): void {
		const terminal = [...this.#records.values()]
			.filter(rec => this.#isTerminal(rec))
			.sort((a, b) => a.view.updatedAt - b.view.updatedAt);
		for (const rec of terminal.slice(0, Math.max(0, terminal.length - TERMINAL_KEEP))) {
			this.#records.delete(rec.installId);
			this.#lines.delete(rec.installId);
		}
	}
}

/**
 * Classify a package-manager failure.
 *
 * Only one attribution is made here, because only one is actionable: a refusal
 * that mentions scripts is a different fix from a network failure, and the
 * person can see the rest of the failure in the transcript.
 */
function classifyInstallFailure(err: unknown): PluginInstallFailureKind {
	const message = err instanceof Error ? err.message : String(err);
	if (/script|trustedDependencies|blocked/i.test(message)) return "scripts";
	return "install";
}
