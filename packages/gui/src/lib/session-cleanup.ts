import type { RpcClient } from "./rpc";

/**
 * Stale-session cleanup (Settings → 会话 → 自动清理 parity). Shared by the
 * settings page (manual "立即清理" + preview counts) and the app shell
 * (hourly auto-run while the pref is on — the settings page's own timer
 * dies the moment the panel closes, which is exactly when the auto
 * cleanup should keep running).
 */

export const CLEANUP_KEY = "omp-gui-autoclean";
export const CLEANUP_DAYS_KEY = "omp-gui-autoclean-days";
export const CLEANUP_ACTION_KEY = "omp-gui-autoclean-action";

export function cleanupEnabled(): boolean {
	try {
		return localStorage.getItem(CLEANUP_KEY) === "1";
	} catch {
		return false;
	}
}

export function cleanupDays(): number {
	try {
		const v = Number(localStorage.getItem(CLEANUP_DAYS_KEY));
		return Number.isFinite(v) && v >= 1 && v <= 365 ? v : 30;
	} catch {
		return 30;
	}
}

export function cleanupAction(): "archive" | "delete" {
	try {
		return localStorage.getItem(CLEANUP_ACTION_KEY) === "delete" ? "delete" : "archive";
	} catch {
		return "archive";
	}
}

export interface CleanupCandidate {
	id: string;
}

/** Sessions older than the cutoff, excluding the current one and the 5
 *  most recently active (openchamber keepRecent parity). */
export async function cleanupCandidates(
	rpc: RpcClient,
	days: number,
	currentSessionId: string | null,
): Promise<CleanupCandidate[]> {
	const list = await rpc.request<Array<{ id: string; timestamp: string }>>("session.list", {}).catch(() => null);
	if (!list) return [];
	const cutoff = Date.now() - days * 86_400_000;
	const sorted = [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const keep = new Set(sorted.slice(0, 5).map(s => s.id));
	return sorted
		.filter(s => s.id !== currentSessionId && !keep.has(s.id) && new Date(s.timestamp).getTime() < cutoff)
		.map(s => ({ id: s.id }));
}

/** Archive (session.close → history snapshot) or delete each candidate. */
export async function runCleanupOnce(
	rpc: RpcClient,
	ids: Array<string | CleanupCandidate>,
	action: "archive" | "delete",
): Promise<void> {
	for (const entry of ids) {
		const id = typeof entry === "string" ? entry : entry.id;
		try {
			await rpc.request(action === "archive" ? "session.close" : "session.delete", { sessionId: id });
		} catch {
			// keep going — one failing session must not block the rest
		}
	}
}
