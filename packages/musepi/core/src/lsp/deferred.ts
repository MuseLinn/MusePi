// ============================================================
// MusePi LSP — deferred post-mutation diagnostics coordinator.
//
// Port of OMP's DeferredDiagnostics: every file mutation bumps a per-path
// version; an async fetch that started before a newer mutation produces a
// stale entry that is dropped instead of injected. Entries sit in a
// pending buffer until the host's transformContext seam drains them into
// the outgoing context view (non-persistent restatement).
// ============================================================

import { DiagnosticsLedger } from "./ledger.ts";

export interface DeferredDiagnosticsEntry {
	/** Workspace-relative path for display. */
	path: string;
	/** Formatted `path:line:col [severity] …` lines, ledger-deduped. */
	messages: string[];
	summary: string;
	errored: boolean;
	/** True when a newer mutation landed after this batch was fetched. */
	isStale: () => boolean;
}

export class DeferredDiagnosticsCoordinator {
	readonly ledger = new DiagnosticsLedger();
	readonly #versions = new Map<string, number>();
	readonly #pending: DeferredDiagnosticsEntry[] = [];

	/** Bump and return the mutation version for a path (call on every successful mutation). */
	bumpVersion(absPath: string): number {
		const next = (this.#versions.get(absPath) ?? 0) + 1;
		this.#versions.set(absPath, next);
		return next;
	}

	version(absPath: string): number {
		return this.#versions.get(absPath) ?? 0;
	}

	/**
	 * Offer a fetched batch. The entry is wrapped with a staleness closure
	 * over the mutation version captured when the fetch began.
	 */
	offer(entry: Omit<DeferredDiagnosticsEntry, "isStale">, absPath: string, mutationVersion: number): void {
		this.#pending.push({
			...entry,
			isStale: () => this.version(absPath) !== mutationVersion,
		});
	}

	/** Drain non-stale pending entries (stale ones are dropped silently). */
	drain(): DeferredDiagnosticsEntry[] {
		const fresh = this.#pending.filter((entry) => !entry.isStale());
		this.#pending.length = 0;
		return fresh;
	}

	get pendingCount(): number {
		return this.#pending.length;
	}
}

/** Render drained entries as the trailing synthetic user message for the outgoing context view. */
export function renderDeferredDiagnostics(entries: DeferredDiagnosticsEntry[]): string {
	const sections: string[] = [
		"The language server reports diagnostics after your recent file edit(s). Review them and fix any that relate to your change:",
	];
	for (const entry of entries) {
		const body = entry.messages.map((message) => `  ${message}`).join("\n");
		sections.push(`\n${entry.path} (${entry.summary}):\n${body}`);
	}
	return sections.join("\n");
}
