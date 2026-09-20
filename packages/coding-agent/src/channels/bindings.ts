import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelBindingSnapshot } from "./handler";

/** Chat↔session bindings survive daemon restarts (a plain text message must
 *  still route to the session it was bound to before). Tiny JSON, written
 *  synchronously on the rare bind/unbind path. */
export function loadChannelBindings(path: string): ChannelBindingSnapshot {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && "bindings" in parsed) {
			return parsed as ChannelBindingSnapshot;
		}
	} catch {
		// missing/corrupt → fresh
	}
	return { bindings: {} };
}

export function saveChannelBindings(path: string, snapshot: ChannelBindingSnapshot): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(snapshot, null, "\t"));
}
