import { t } from "@musepi/client-core";
import { pushActionToast } from "./action-toast";
import type { RpcClient } from "./rpc";
import { onSettingsChanged } from "./settings-events";

const LID_SLEEP_KEY = "power.preventLidSleep";

/**
 * Mirror the daemon's lid-closed sleep setting onto the desktop shell.
 *
 * The daemon records `power.preventLidSleep` but cannot apply it: the macOS
 * assertion must outlive daemon restarts and the Windows/Linux mechanisms
 * change machine state the shell restores on quit. Reads the stored value
 * once (covering launch re-acquisition and TUI edits made while running),
 * then follows every committed write of that key.
 *
 * Returns a disposer. Failures surface as a toast and leave the daemon value
 * untouched, so the switch keeps showing what the machine actually does.
 */
export function syncLidSleepToShell(rpc: RpcClient): () => void {
	const bridge = window.electronAPI;
	if (!bridge?.setLidSleep) return () => {};

	let alive = true;
	let applied: boolean | undefined;
	// Serialize writes: two quick toggles must reach main in order, and the
	// last one wins.
	let queue: Promise<void> = Promise.resolve();

	const apply = (enabled: boolean): void => {
		queue = queue.then(async () => {
			if (!alive) return;
			// Compare against what the shell actually holds, not against the last
			// value we asked for: a relaunched shell starts holding nothing even
			// though the preference is still on, and must re-acquire.
			const held = applied ?? (await bridge.lidSleepState()).enabled;
			if (!alive || held === enabled) {
				applied = held;
				return;
			}
			const state = await bridge.setLidSleep(enabled);
			if (!alive) return;
			// Always keep the shell's real state: a refused change leaves the row
			// claiming a state the machine rejected, which the failure names.
			applied = state.enabled;
			if (state.error) {
				pushActionToast({ kind: "error", message: t("settings.lidSleepFailed"), details: state.error });
			}
		});
		void queue.catch(() => {});
	};

	const read = (): void => {
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: [LID_SLEEP_KEY] })
			.then(values => {
				if (alive) apply(values?.[LID_SLEEP_KEY] === true);
			})
			.catch(() => {});
	};

	read();
	const off = onSettingsChanged(({ key }) => {
		if (key === LID_SLEEP_KEY) read();
	});
	return () => {
		alive = false;
		off();
	};
}
