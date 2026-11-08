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
 * Event names follow dsh: `hmr/change` reports a file batch, `hmr/reload`
 * reports that a reload pass has started for that batch. They are delivered on
 * the service (the same object `ctx.hmr` is) rather than through the extension
 * event bus, because HMR is process-wide while extension listeners are
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
	/** Subscribe to a named event. Returns a disposer; subscriptions are not
	 *  tied to a plugin's lifetime automatically, so call `ctx.effect` with the
	 *  disposer when the listener must not outlive its owner. */
	on(event: HmrEventName, listener: HmrListener): () => void;
	/** Alias for `on("hmr/change", …)`, the pre-event-name surface. */
	onChange(listener: HmrListener): () => void;
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

class WatchedHmrService implements HmrService {
	readonly roots: readonly string[];
	readonly #debounceMs: number;
	readonly #ignored: readonly string[];
	readonly #listeners = new Map<HmrEventName, Set<HmrListener>>();
	readonly #pending = new Set<string>();
	#timer: Timer | null = null;
	#watcher: FSWatcher | null = null;
	#disposed = false;
	#queue: Promise<unknown> = Promise.resolve();
	#graph: HmrGraphQueries | null = null;

	constructor(roots: readonly string[], debounceMs: number, ignored: readonly string[] = []) {
		this.roots = roots;
		this.#debounceMs = debounceMs;
		this.#ignored = ignored;
	}

	get enabled(): boolean {
		return !this.#disposed && this.roots.length > 0;
	}

	on(event: HmrEventName, listener: HmrListener): () => void {
		if (this.#disposed) return () => {};
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return () => {
			this.#listeners.get(event)?.delete(listener);
		};
	}

	onChange(listener: HmrListener): () => void {
		return this.on("hmr/change", listener);
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
		this.#listeners.clear();
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
			for (const listener of [...(this.#listeners.get(event) ?? [])]) {
				try {
					void Promise.resolve(listener(change)).catch(error => {
						logger.warn("hmr listener failed", { event, error: String(error) });
					});
				} catch (error) {
					logger.warn("hmr listener failed", { event, error: String(error) });
				}
			}
		}
	}
}

/** Create (and start) one watcher over `roots`. The host plugin owns disposal. */
export function createHmrService(
	roots: readonly string[],
	debounceMs = 100,
	ignored: readonly string[] = [],
): HmrService {
	const service = new WatchedHmrService(roots, debounceMs, ignored);
	service.start();
	return service;
}
