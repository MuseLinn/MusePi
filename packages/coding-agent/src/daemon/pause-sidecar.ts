import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Per-session pause sidecar: presence = session currently paused. The
 * AgentPauseGate lives only in memory (idle-archive closes the session),
 * so the daemon mirrors each transition here and rehydrates the gate on
 * reactivation — a paused session stays paused across archive/restart.
 * Sidecar files live under the daemon journal dir; `dir` is injectable
 * for tests (defaults to the real journal when omitted).
 */

export function pauseSidecarPath(sessionId: string, dir: string): string {
	return path.join(dir, `${sessionId}.pause.json`);
}

export async function readPauseSidecar(
	sessionId: string,
	dir: string,
): Promise<{ paused: boolean; pausedAt: number | null }> {
	try {
		const raw = await fs.promises.readFile(pauseSidecarPath(sessionId, dir), "utf8");
		const parsed = JSON.parse(raw) as { paused?: unknown; pausedAt?: unknown };
		if (parsed.paused !== true) return { paused: false, pausedAt: null };
		const pausedAt = typeof parsed.pausedAt === "number" ? parsed.pausedAt : null;
		return { paused: true, pausedAt };
	} catch (error) {
		// Missing/corrupt sidecar = not paused. A read failure must never
		// block session activation; the gate defaults to running.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[daemon] pause sidecar read failed for ${sessionId}: ${String(error)}`);
		}
		return { paused: false, pausedAt: null };
	}
}

/** Mirror a gate transition to the sidecar. `paused: false` removes the
 *  file (absence is the non-paused state); failures are best-effort — the
 *  gate stays authoritative for the live session and only the next
 *  archive/reactivation could observe a stale pause. */
export function writePauseSidecar(sessionId: string, paused: boolean, pausedAt: number | null, dir: string): void {
	const p = pauseSidecarPath(sessionId, dir);
	void (async () => {
		try {
			if (paused) {
				await fs.promises.mkdir(dir, { recursive: true });
				await fs.promises.writeFile(p, JSON.stringify({ paused: true, pausedAt }));
			} else {
				await fs.promises.unlink(p).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		} catch (error) {
			console.warn(`[daemon] pause sidecar write failed for ${sessionId}: ${String(error)}`);
		}
	})();
}
