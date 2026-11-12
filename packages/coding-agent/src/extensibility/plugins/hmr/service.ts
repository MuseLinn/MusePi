/**
 * Host-level hot reload, exposed as a host plugin (`musepi-hmr`, `musepi.scope:
 * "host"`) that provides `ctx.hmr` — the dsh shape, where HMR is a Cordis
 * service rather than daemon-private machinery.
 *
 * The watcher is one per process: the same roots serve the daemon (whose
 * extension caches and GUI slots refresh on change) and every other host
 * (TUI/ACP/SDK), so a plugin that reacts to its own reload needs one
 * subscription. Detection and reaction are separate: this service reports what
 * changed and in what batch, and each host decides which caches to drop.
 */

import { Context } from "@deepseek-ai/cordis";
import { logger } from "@musepi/pi-utils";
import { type FSWatcher, watch } from "chokidar";

/** One batched change notification. */
export interface HmrChange {
	/** `watch` for file events, `manual` for an explicit `reload()`. */
	readonly trigger: "watch" | "manual";
	/** Absolute paths in arrival order, deduplicated. */
	readonly paths: readonly string[];
}

export type HmrListener = (change: HmrChange) => void | Promise<void>;

/**
 * A change that cannot be applied in place and needs the host to restart.
 * The HMR service does not restart anything itself: it reports the
 * requirement to the host, which owns the process lifecycle (the daemon's
 * supervisor, the desktop shell, or a TUI that asks the user to relaunch).
 */
export interface HmrRestartRequirement {
	/** The file that could not be replaced, when a single file caused it. */
	readonly file?: string;
	/** The plugin whose change could not be applied, when there is one. */
	readonly entry?: string;
	/** Human-readable cause, used in logs and host notices. */
	readonly reason: string;
}

/**
 * Event names follow dsh: `hmr/change` reports a file batch, `hmr/reload`
 * reports that a reload pass has started for that batch. They are dispatched
 * through a real Cordis event service (the mechanism dsh uses: one registry,
 * `prepend` ordering, parallel/serial dispatch); the context is local to the
 * service because HMR is process-wide while the runner's event context is
 * session-scoped.
 */
export type HmrEventName = "hmr/change" | "hmr/reload";

/** Module-graph questions a loader can answer for the service (dsh `getLinked`
 *  / `getOuterStack`). Absent until a host attaches its graph. */
export interface HmrGraphQueries {
	/** Entries whose managed file set contains `file`. */
	linkedEntries(file: string): readonly string[];
	/** Importer chain from `file` up to its entry, outermost first. */
	outerStack(file: string): readonly string[];
}

export interface HmrService {
	readonly enabled: boolean;
	readonly roots: readonly string[];
	/** Subscribe to a named event through the Cordis event service — same
	 *  registry, dispatch and `prepend` ordering as dsh. Returns a disposer;
	 *  subscriptions are not tied to a plugin's lifetime automatically, so call
	 *  `ctx.effect` with the disposer when the listener must not outlive its
	 *  owner. */
	on(event: HmrEventName, listener: HmrListener, options?: { prepend?: boolean }): () => void;
	/** Alias for `on("hmr/change", …)`, the pre-event-name surface. */
	onChange(listener: HmrListener): () => void;
	/**
	 * Ask the host to restart because a change cannot be applied in place.
	 * A host that can restart subscribes to {@link onRestartRequired}; one
	 * that cannot still gets the log line and can surface
	 * {@link restartRequired} in its UI.
	 */
	requestRestart(requirement: HmrRestartRequirement): void;
	/** Every outstanding restart request, oldest first. */
	readonly restartRequirements: readonly HmrRestartRequirement[];
	/** The oldest outstanding request, or null when nothing needs a restart. */
	readonly restartRequired: HmrRestartRequirement | null;
	/** Mark one request as handled without dropping any newer requirement. */
	acknowledgeRestart(requirement: HmrRestartRequirement): void;
	/** Subscribe to restart requests. Returns a disposer. */
	onRestartRequired(listener: (requirement: HmrRestartRequirement) => void): () => void;
	/** Run the current listeners as if the watched files had changed. */
	reload(): Promise<void>;
	/** Serialize a transaction against reload batches (dsh `runExclusive`):
	 *  installs and config writes use this so they never observe a half-applied
	 *  reload. Nested calls queue instead of interleaving. */
	runExclusive<T>(transaction: () => Promise<T> | T): Promise<T>;
	/** Entries that own `file`; empty when the file is not part of a plugin. */
	getLinked(file: string): readonly string[];
	/** Importer chain from `file` to its entry; empty when unmanaged. */
	getOuterStack(file: string): readonly string[];
	/** Attach the loader's module graph. Returns a disposer. */
	attachGraph(graph: HmrGraphQueries): () => void;
	dispose(): Promise<void>;
}

/** The slice of Cordis's event service this file uses (its `Events` map is
 *  typed empty for a bare Context, so the names are cast at the boundary). */
interface HmrEventBus {
	on(name: string, listener: (change: HmrChange) => unknown, options?: { prepend?: boolean }): () => boolean;
	parallel(name: string, ...args: unknown[]): Promise<unknown>;
}

class WatchedHmrService implements HmrService {
	readonly roots: readonly string[];
	readonly #debounceMs: number;
	readonly #ignored: ReadonlyArray<string | RegExp>;
	/** The Cordis event service for `hmr/*`. A bare Context is its own event
	 *  bus; listeners are owned by the disposers we keep. */
	readonly #bus = new Context() as unknown as HmrEventBus;
	readonly #disposers: Array<() => boolean> = [];
	readonly #pending = new Set<string>();
	#timer: Timer | null = null;
	#watcher: FSWatcher | null = null;
	#disposed = false;
	#queue: Promise<unknown> = Promise.resolve();
	#graph: HmrGraphQueries | null = null;
	readonly #restartRequirements = new Map<string, HmrRestartRequirement>();
	readonly #restartListeners = new Set<(requirement: HmrRestartRequirement) => void>();

	constructor(roots: readonly string[], debounceMs: number, ignored: ReadonlyArray<string | RegExp> = []) {
		this.roots = roots;
		this.#debounceMs = debounceMs;
		this.#ignored = ignored;
	}

	get enabled(): boolean {
		return !this.#disposed && this.roots.length > 0;
	}

	on(event: HmrEventName, listener: HmrListener, options?: { prepend?: boolean }): () => void {
		if (this.#disposed) return () => {};
		// One listener failure must not stop its siblings, so the isolation
		// wrapper sits inside Cordis's dispatch rather than around it.
		const wrapped = async (change: HmrChange): Promise<void> => {
			try {
				await listener(change);
			} catch (error) {
				logger.warn("hmr listener failed", { event, error: String(error) });
			}
		};
		const dispose = this.#bus.on(event, wrapped, options);
		this.#disposers.push(dispose);
		return () => {
			dispose();
			const index = this.#disposers.indexOf(dispose);
			if (index >= 0) this.#disposers.splice(index, 1);
		};
	}

	onChange(listener: HmrListener): () => void {
		return this.on("hmr/change", listener);
	}

	get restartRequired(): HmrRestartRequirement | null {
		return this.#restartRequirements.values().next().value ?? null;
	}

	get restartRequirements(): readonly HmrRestartRequirement[] {
		return [...this.#restartRequirements.values()];
	}

	acknowledgeRestart(requirement: HmrRestartRequirement): void {
		this.#restartRequirements.delete(this.#restartKey(requirement));
	}

	#restartKey(requirement: HmrRestartRequirement): string {
		return JSON.stringify([requirement.file ?? null, requirement.entry ?? null, requirement.reason]);
	}

	requestRestart(requirement: HmrRestartRequirement): void {
		if (this.#disposed) return;
		const key = this.#restartKey(requirement);
		if (this.#restartRequirements.has(key)) return;
		this.#restartRequirements.set(key, requirement);
		logger.warn("host restart required", {
			reason: requirement.reason,
			file: requirement.file,
			entry: requirement.entry,
		});
		for (const listener of [...this.#restartListeners]) {
			try {
				listener(requirement);
			} catch (error) {
				logger.warn("hmr restart listener failed", { error: String(error) });
			}
		}
	}

	onRestartRequired(listener: (requirement: HmrRestartRequirement) => void): () => void {
		if (this.#disposed) return () => {};
		this.#restartListeners.add(listener);
		return () => {
			this.#restartListeners.delete(listener);
		};
	}

	async reload(): Promise<void> {
		if (this.#disposed) return;
		await this.runExclusive(() => this.#flush("manual"));
	}

	runExclusive<T>(transaction: () => Promise<T> | T): Promise<T> {
		const run = this.#queue.then(
			() => transaction(),
			() => transaction(),
		);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	getLinked(file: string): readonly string[] {
		return this.#graph?.linkedEntries(file) ?? [];
	}

	getOuterStack(file: string): readonly string[] {
		return this.#graph?.outerStack(file) ?? [];
	}

	attachGraph(graph: HmrGraphQueries): () => void {
		this.#graph = graph;
		return () => {
			if (this.#graph === graph) this.#graph = null;
		};
	}

	start(): void {
		if (this.#disposed || this.roots.length === 0) return;
		try {
			this.#watcher = watch([...this.roots], {
				ignoreInitial: true,
				// Editors write through rename, which shows up as add+unlink of the
				// same path; a short settle window collapses that into one reload.
				awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
				ignored: [/(?:^|[/\\])(?:\.git|node_modules[/\\]\.cache)(?:[/\\]|$)/, ...this.#ignored],
			});
			this.#watcher.on("all", (_event, changed) => {
				if (changed) this.#pending.add(changed);
				this.#schedule();
			});
			logger.info("hmr watcher attached", { roots: this.roots });
		} catch (error) {
			// Watching is an optimization: discovery TTL still picks changes up.
			logger.warn("hmr watcher attach failed; discovery TTL still applies", { error: String(error) });
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		for (const dispose of this.#disposers.splice(0)) dispose();
		this.#restartListeners.clear();
		this.#restartRequirements.clear();
		this.#pending.clear();
		const watcher = this.#watcher;
		this.#watcher = null;
		if (watcher) {
			try {
				await watcher.close();
			} catch (error) {
				logger.warn("hmr watcher close failed", { error: String(error) });
			}
		}
	}

	#schedule(): void {
		if (this.#timer !== null) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.runExclusive(() => this.#flush("watch")).catch(error => {
				logger.warn("hmr batch failed", { error: String(error) });
			});
		}, this.#debounceMs);
	}

	#flush(trigger: HmrChange["trigger"]): void {
		const paths = [...this.#pending];
		this.#pending.clear();
		const change: HmrChange = { trigger, paths };
		for (const event of ["hmr/change", "hmr/reload"] as const) {
			void this.#bus.parallel(event, change).catch(error => {
				logger.warn("hmr dispatch failed", { event, error: String(error) });
			});
		}
	}
}

/** Create (and start) one watcher over `roots`. The host plugin owns disposal. */
export function createHmrService(
	roots: readonly string[],
	debounceMs = 100,
	ignored: ReadonlyArray<string | RegExp> = [],
): HmrService {
	const service = new WatchedHmrService(roots, debounceMs, ignored);
	service.start();
	return service;
}
