// Minimal preload for the computer-use glow overlay window. The overlay
// is a plain static page (no bundle); it only needs to receive
// computer-input target events from the main process. Kept separate from
// the main preload.cjs so the overlay page cannot reach pet/main-window
// controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glowBridge", {
	/** Subscribe to desktop input target events (one per action). */
	onTarget(callback) {
		const listener = (_event, input) => callback(input);
		ipcRenderer.on("glow:target", listener);
		return () => ipcRenderer.removeListener("glow:target", listener);
	},
});
