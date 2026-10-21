/**
 * Large plain-text paste → a file attachment.
 *
 * A big paste would flood the prompt. The obvious answer — a dialog asking
 * what to do with it — interrupts the user at the worst moment: they pasted a
 * log to look at it, and a modal appears before they read a line of it.
 *
 * The gesture here answers that better. The FIRST paste of a large text is
 * inserted normally, so the user sees what they pasted. If they paste the SAME
 * text again within a second, that is the signal that inserting it inline was
 * not what they wanted: the text becomes an attachment and the inline copy is
 * replaced by a citation.
 *
 * A single large paste therefore never blocks, and the escape hatch is
 * discovered by the person who needs it rather than imposed on everyone.
 *
 * 宿主是 textarea（非 CodeMirror），文档从 value 读取。
 */

const LARGE_TEXT_PASTE_CHAR_THRESHOLD = 2000;
const LARGE_TEXT_PASTE_LINE_THRESHOLD = 25;

/** How long a first paste stays "the same paste" for the second one to count. */
const DOUBLE_PASTE_WINDOW_MS = 1000;

function countLines(text: string): number {
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

/**
 * Whether a pasted plain text is large enough to be worth offering as a file.
 *
 * The thresholds are OR'd: a very long single line and a moderately long block
 * are both worth turning into an attachment.
 */
export function isLargePlainTextPaste(
	text: string,
	options?: { charThreshold?: number; lineThreshold?: number },
): boolean {
	if (!text || !text.trim()) return false;
	const charThreshold = options?.charThreshold ?? LARGE_TEXT_PASTE_CHAR_THRESHOLD;
	const lineThreshold = options?.lineThreshold ?? LARGE_TEXT_PASTE_LINE_THRESHOLD;
	if (text.length >= charThreshold) return true;
	return countLines(text) >= lineThreshold;
}

/** The snapshot of the textarea a paste happened in. */
export interface PasteSnapshot {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

export interface LargeTextPasteCandidate {
	readonly clipboardText: string;
	/** The text as it sits in the composer now. */
	readonly value: string;
	readonly from: number;
	readonly to: number;
	readonly pastedAt: number;
}

type PasteGestureState =
	| { kind: "idle" }
	| { kind: "pending"; clipboardText: string; from: number; pastedAt: number }
	| { kind: "inline"; candidate: LargeTextPasteCandidate }
	| { kind: "ready"; candidate: LargeTextPasteCandidate }
	| { kind: "attaching"; candidate: LargeTextPasteCandidate };

/**
 * One composer-owned, short-lived gesture.
 *
 * The first insertion stays native; the second identical paste within the window
 * is the one that offers the attachment.
 */
export class LargeTextPasteGesture {
	#state: PasteGestureState = { kind: "idle" };
	#expiry: ReturnType<typeof setTimeout> | null = null;

	invalidate(): void {
		if (this.#expiry !== null) clearTimeout(this.#expiry);
		this.#expiry = null;
		this.#state = { kind: "idle" };
	}

	/**
	 * Called before the browser inserts the pasted text.
	 *
	 * @returns the candidate to act on, or null to let the paste land normally.
	 */
	beginPaste(text: string, snapshot: PasteSnapshot, now = Date.now()): LargeTextPasteCandidate | null {
		const previous = this.#state;
		this.invalidate();
		if (!isLargePlainTextPaste(text)) return null;
		if (previous.kind === "inline") {
			const candidate = previous.candidate;
			const elapsed = now - candidate.pastedAt;
			// The same clipboard text, inside the window, pasted into the same
			// place: that is the second paste of one intent.
			if (elapsed >= 0 && elapsed < DOUBLE_PASTE_WINDOW_MS && text === candidate.clipboardText) {
				this.#state = { kind: "ready", candidate };
				return candidate;
			}
		}
		this.#state = { kind: "pending", clipboardText: text, from: snapshot.selectionStart, pastedAt: now };
		this.#expiry = setTimeout(() => this.invalidate(), DOUBLE_PASTE_WINDOW_MS);
		return null;
	}

	/**
	 * Called after the browser inserted the text.
	 *
	 * The insertion is only the first half of the gesture when it matches what
	 * the paste was about to do — a different edit means the user typed
	 * something else, and the gesture is over. The inserted length is the
	 * clipboard text's length, which the pending state already knows.
	 */
	change(snapshot: PasteSnapshot): void {
		const pending = this.#state;
		if (pending.kind !== "pending") {
			this.invalidate();
			return;
		}
		const isFirstInsertion =
			snapshot.selectionStart === snapshot.selectionEnd &&
			snapshot.selectionEnd - pending.from === pending.clipboardText.length;
		if (!isFirstInsertion) {
			this.invalidate();
			return;
		}
		this.#state = {
			kind: "inline",
			candidate: {
				clipboardText: pending.clipboardText,
				value: snapshot.value,
				from: pending.from,
				to: snapshot.selectionEnd,
				pastedAt: pending.pastedAt,
			},
		};
	}

	/**
	 * Converts the inline text into an attachment.
	 *
	 * @returns whether the conversion happened — false when the gesture was
	 *   superseded, so the caller leaves the text alone.
	 */
	async convert(
		candidate: LargeTextPasteCandidate,
		attach: () => Promise<boolean>,
		read: () => PasteSnapshot | null,
		replace: (from: number, to: number, citation: string) => void,
		citation: string,
	): Promise<boolean> {
		if (this.#state.kind !== "ready" || this.#state.candidate !== candidate) return false;
		const attaching: PasteGestureState = { kind: "attaching", candidate };
		this.#state = attaching;
		try {
			if (!(await attach()) || this.#state !== attaching) return false;
			const snapshot = read();
			// The text must still be where the gesture left it: the user may
			// have edited it while the attachment was being prepared.
			if (!snapshot || !this.#matches(candidate, snapshot)) return false;
			this.invalidate();
			replace(candidate.from, candidate.to, citation);
			return true;
		} finally {
			if (this.#state === attaching) this.invalidate();
		}
	}

	#matches(candidate: LargeTextPasteCandidate, snapshot: PasteSnapshot): boolean {
		return (
			snapshot.value === candidate.value &&
			snapshot.selectionStart === candidate.to &&
			snapshot.selectionEnd === candidate.to
		);
	}
}
