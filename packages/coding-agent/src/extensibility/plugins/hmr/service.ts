/**
 * Host-level hot reload as a service, mirroring dsh's `ctx.hmr`.
 *
 * The watcher is one per process: the same roots serve the daemon (whose
 * extension caches and GUI slots refresh on change) and every other host
 * (TUI/ACP/SDK), so a plugin that reacts to its own reload only needs one
 * subscription. Detection and reaction are separate: this service reports what
 * changed and in what batch, and each host decides which caches to drop —
 * those decisions differ per surface and do not belong in a shared watcher.
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

export interface HmrService {
	readonly enabled: boolean;
	readonly roots: readonly string[];
	/** Subscribe to batched changes. Returns a disposer; subscriptions are not
	 *  tied to a plugin's lifetime automatically, so call `ctx.effect` with the
	 *  disposer when the listener must not outlive its owner. */
	onChange(listener: HmrListener): () => void;
	/** Run the current listeners as if the watched files had changed. */
	reload(): Promise<void>;
	dispose(): Promise<void>;
}

class WatchedHmrService implements HmrService {
	readonly roots: readonly string[];
	readonly #debounceMs: number;
	readonly #listeners = new Set<HmrListener>();
	readonly #pending = new Set<string>();
	#timer: Timer | null = null;
	#watcher: FSWatcher | null = null;
	#disposed = false;

	constructor(roots: readonly string[], debounceMs: number) {
		this.roots = roots;
		this.#debounceMs = debounceMs;
	}

	get enabled(): boolean {
		return !this.#disposed;
	}

	onChange(listener: HmrListener): () => void {
		if (this.#disposed) return () => {};
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async reload(): Promise<void> {
		if (this.#disposed) return;
		this.#flush("manual");
	}

	start(): void {
		if (this.#disposed || this.roots.length === 0) return;
		try {
			this.#watcher = watch([...this.roots], {
				ignoreInitial: true,
				// Editors write through rename, which shows up as add+unlink of the
				// same path; a short settle window collapses that into one reload.
				awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
				ignored: /(?:^|[/\\])(?:\.git|node_modules[/\\]\.cache)(?:[/\\]|$)/,
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
			this.#flush("watch");
		}, this.#debounceMs);
	}

	#flush(trigger: HmrChange["trigger"]): void {
		const paths = [...this.#pending];
		this.#pending.clear();
		const change: HmrChange = { trigger, paths };
		for (const listener of [...this.#listeners]) {
			try {
				void Promise.resolve(listener(change)).catch(error => {
					logger.warn("hmr listener failed", { error: String(error) });
				});
			} catch (error) {
				logger.warn("hmr listener failed", { error: String(error) });
			}
		}
	}
}

let current: WatchedHmrService | null = null;

/** The process-wide service, or null when no host started one. */
export function getHmrService(): HmrService | null {
	return current;
}

/** Start (or reuse) the process-wide watcher over `roots`. */
export function startHmrService(options: { roots: readonly string[]; debounceMs?: number }): HmrService {
	if (current?.enabled) return current;
	const service = new WatchedHmrService(options.roots, options.debounceMs ?? 100);
	service.start();
	current = service;
	return service;
}

export async function stopHmrService(): Promise<void> {
	const service = current;
	current = null;
	await service?.dispose();
}
