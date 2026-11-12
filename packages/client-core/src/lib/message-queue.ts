export type QueueGroup = "steering" | "followUp";

export interface QueuedMessageItem {
	id: string;
	text: string;
	imageCount: number;
}

export interface QueueSnapshot {
	count: number;
	paused: boolean;
	steering: QueuedMessageItem[];
	followUp: QueuedMessageItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readItems(value: unknown): QueuedMessageItem[] {
	if (!Array.isArray(value)) return [];
	const items: QueuedMessageItem[] = [];
	for (const row of value) {
		// Older daemons identify rows by text. Keeping that text as the id lets
		// the same client retain the daemon's text fallback during an upgrade.
		if (typeof row === "string") {
			items.push({ id: row, text: row, imageCount: 0 });
			continue;
		}
		if (!isRecord(row) || typeof row.id !== "string" || typeof row.text !== "string") continue;
		const imageCount = typeof row.imageCount === "number" && row.imageCount > 0 ? Math.floor(row.imageCount) : 0;
		// An empty row has nothing to send, nothing to restore and nothing to
		// show: surfacing it produced a queue chip whose panel was blank and
		// whose rows could not be told apart from a rendering bug.
		if (row.text.trim().length === 0 && imageCount === 0) continue;
		items.push({ id: row.id, text: row.text, imageCount });
	}
	return items;
}

/** Normalize current and pre-stable-id `session.queued` responses at the wire boundary. */
export function normalizeQueueSnapshot(value: unknown): QueueSnapshot {
	const record = isRecord(value) ? value : {};
	const steering = readItems(record.steering);
	const followUp = readItems(record.followUp);
	return {
		// Count the ROWS, not the daemon's pending-work total. The wire count
		// also includes parked advisor cards and hidden next-turn notices,
		// which are not rows and are not cleared by 清空队列 — trusting it left
		// a "队列 1" chip above an empty panel that no action could dismiss.
		count: steering.length + followUp.length,
		paused: record.paused === true,
		steering,
		followUp,
	};
}
