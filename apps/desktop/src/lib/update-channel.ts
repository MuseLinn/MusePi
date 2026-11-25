import { setUpdateAutoRestart, setUpdateChannel, type UpdateChannel } from "./electron";
import type { RpcClient } from "./rpc";
import { onSettingsChanged } from "./settings-events";

/**
 * Mirror the daemon-owned update preferences (`update.channel`,
 * `update.autoRestart`) into the Electron updater.
 *
 * The main process cannot read daemon settings — its cold-start silent check
 * runs before any daemon exists — so the renderer pushes both values on load
 * and after every settings commit, and the updater persists the last choice
 * for the next launch. `apply` / `applyAutoRestart` are the shell bridges,
 * injectable so a test can observe the mirror without installing a global
 * `electronAPI`.
 *
 * Returns the unsubscribe function.
 */
export function syncUpdateChannel(
	rpc: RpcClient,
	apply: (channel: UpdateChannel) => unknown = setUpdateChannel,
	applyAutoRestart: (enabled: boolean) => unknown = setUpdateAutoRestart,
): () => void {
	let alive = true;
	const push = (): void => {
		void rpc
			.request<Record<string, unknown> | null>("settings.get", {
				keys: ["update.channel", "update.autoRestart"],
			})
			.then(values => {
				if (!alive) return;
				void apply(values?.["update.channel"] === "beta" ? "beta" : "stable");
				void applyAutoRestart(values?.["update.autoRestart"] !== false);
			})
			.catch(() => {});
	};
	push();
	const off = onSettingsChanged(detail => {
		// Any commit may have touched a preference (schema-driven writes name
		// their own key), and one small settings.get is cheaper than tracking
		// key aliases across surfaces.
		if (detail.key === "update.channel" || detail.key === "update.autoRestart" || detail.key === "") push();
	});
	return () => {
		alive = false;
		off();
	};
}
