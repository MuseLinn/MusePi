import { setUpdateChannel } from "./electron";
import type { RpcClient } from "./rpc";
import { onSettingsChanged } from "./settings-events";

/**
 * Mirror the daemon-owned `update.channel` setting into the Electron updater.
 *
 * The main process cannot read daemon settings — its cold-start silent check
 * runs before any daemon exists — so the renderer pushes the value on load
 * and after every settings commit, and the updater persists the last choice
 * for the next launch. Returns the unsubscribe function.
 */
export function syncUpdateChannel(rpc: RpcClient): () => void {
	let alive = true;
	const push = (): void => {
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: ["update.channel"] })
			.then(values => {
				if (!alive) return;
				void setUpdateChannel(values?.["update.channel"] === "beta" ? "beta" : "stable");
			})
			.catch(() => {});
	};
	push();
	const off = onSettingsChanged(detail => {
		// Any commit may have touched the channel (schema-driven writes name
		// their own key), and one small settings.get is cheaper than tracking
		// key aliases across surfaces.
		if (detail.key === "update.channel" || detail.key === "") push();
	});
	return () => {
		alive = false;
		off();
	};
}
