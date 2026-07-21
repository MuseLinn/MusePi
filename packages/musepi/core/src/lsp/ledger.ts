// ============================================================
// MusePi LSP — diagnostics ledger (port of OMP's diagnostics-ledger).
//
// Dedupes post-mutation diagnostics across injections: a diagnostic whose
// identity (severity + source + code + message, location stripped) was
// already injected for this file is not injected again. When a file goes
// clean the ledger entry is dropped, so the next issue counts as fresh.
// ============================================================

import { diagnosticLineIdentity, summarizeDiagnosticMessages } from "./utils.ts";

export interface FileDiagnosticsResult {
	messages: string[];
	summary: string;
	errored: boolean;
}

export class DiagnosticsLedger {
	readonly #seen = new Map<string, Set<string>>();

	/**
	 * Fold a new diagnostics batch for `absPath` into the ledger and return
	 * only the messages that were not seen before. The ledger always reflects
	 * the latest batch (not a union), so a fixed diagnostic that later
	 * reappears is reported again.
	 */
	reduce(absPath: string, messages: string[]): FileDiagnosticsResult {
		const previous = this.#seen.get(absPath);
		const currentIdentities = new Set<string>();
		const fresh: string[] = [];

		for (const message of messages) {
			const identity = diagnosticLineIdentity(message);
			currentIdentities.add(identity);
			if (!previous?.has(identity)) fresh.push(message);
		}

		if (currentIdentities.size === 0) this.#seen.delete(absPath);
		else this.#seen.set(absPath, currentIdentities);

		return { messages: fresh, ...summarizeDiagnosticMessages(fresh) };
	}

	/** Test/introspection helper. */
	knownIdentities(absPath: string): ReadonlySet<string> {
		return this.#seen.get(absPath) ?? new Set();
	}
}
