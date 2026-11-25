/**
 * Daemon admission lock for the desktop update handoff.
 *
 * The shell engages it only after an idle inspection, immediately before it
 * stops the daemon and hands the process to the installer. Refusing new work
 * for that window is better than starting a turn the install would kill: the
 * client keeps the message and retries after the relaunch. A handoff that
 * fails releases the lock, so the daemon returns to normal.
 */

/** Stable prefix clients match on, same `CODE: message` shape as SESSION_BUSY. */
export const UPDATE_ADMISSION_ERROR_CODE = "UPDATE_RESTART_PENDING";

export class UpdateAdmissionLock {
	#engagedAt: number | null = null;

	get engaged(): boolean {
		return this.#engagedAt !== null;
	}

	/** Epoch ms when the lock engaged; null while admitted. */
	get engagedAt(): number | null {
		return this.#engagedAt;
	}

	/** Engage for the handoff. False (keeping the first instant) when already engaged. */
	engage(): boolean {
		if (this.#engagedAt !== null) return false;
		this.#engagedAt = Date.now();
		return true;
	}

	/** Release after a failed handoff. False when it was not engaged. */
	release(): boolean {
		if (this.#engagedAt === null) return false;
		this.#engagedAt = null;
		return true;
	}

	/** Throw the retryable refusal for one new-work entry point. */
	assertAdmitted(): void {
		if (this.#engagedAt === null) return;
		throw new Error(`${UPDATE_ADMISSION_ERROR_CODE}: MusePi is restarting to install an update; retry in a moment`);
	}
}
