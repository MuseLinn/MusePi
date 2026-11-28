/** Compile-time contract for the global hold-to-talk monitor. */
import { DictationKeyMonitor } from "../native/index.js";

export function dictationKeyMonitorTypeCheck(): void {
	const monitor = new DictationKeyMonitor("CommandOrControl+Alt+Space", event => {
		const transition: "press" | "release" = event;
		void transition;
	});
	monitor.close();
	monitor.close();
}
