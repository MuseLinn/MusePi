/**
 * Short-lived, single-use pairing codes for the MusePi mobile app.
 *
 * A code is the no-camera path into a LAN share: the app posts it to the
 * daemon's loopback-bridged `pair.resolve` endpoint and gets back the share's
 * web link, so the user can type six digits instead of a URL. Two properties
 * are load-bearing and easy to lose:
 *
 * - **Single use.** A code is spent the moment it resolves. The dialog shows
 *   the code on screen, so a code that kept working for its whole TTL would
 *   also keep working for anyone who photographed the screen.
 * - **Bounded lifetime.** Unused codes expire; the TTL bounds the window in
 *   which a leaked-but-unused code is worth anything.
 *
 * Kept transport-free so the endpoint's contract is testable without standing
 * up a socket, and so a host without a daemon (the TUI's own LAN share) can
 * mint codes from the same rules.
 */

/** How long an unused code stays resolvable. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

interface Entry {
	webLink: string;
	expiresAt: number;
}

export class PairCodes {
	#entries = new Map<string, Entry>();

	/**
	 * Mint a code bound to `webLink`. `now` is injectable so tests can drive
	 * expiry without waiting.
	 */
	mint(webLink: string, now = Date.now()): { code: string; expiresAt: number } {
		this.prune(now);
		let code = "";
		do {
			code = String(Math.floor(100000 + Math.random() * 900000));
		} while (this.#entries.has(code));
		const expiresAt = now + PAIR_CODE_TTL_MS;
		this.#entries.set(code, { webLink, expiresAt });
		return { code, expiresAt };
	}

	/**
	 * Spend `code`: the link comes back exactly once, or null when the code is
	 * unknown, already spent, or expired.
	 */
	spend(code: string, now = Date.now()): string | null {
		const entry = this.#entries.get(code);
		// Unknown includes already-spent — a spent code is deleted, not marked.
		if (!entry) return null;
		this.#entries.delete(code);
		if (entry.expiresAt < now) return null;
		return entry.webLink;
	}

	/** Drop expired codes. Called lazily from mint(). */
	prune(now = Date.now()): void {
		for (const [code, entry] of this.#entries) {
			if (entry.expiresAt < now) this.#entries.delete(code);
		}
	}

	/** Forget every code — sharing stopped, so none of them lead anywhere. */
	clear(): void {
		this.#entries.clear();
	}

	/** Live (unspent, unexpired) code count. */
	get size(): number {
		return this.#entries.size;
	}
}
