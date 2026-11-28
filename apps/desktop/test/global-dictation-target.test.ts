import { describe, expect, test, vi } from "bun:test";
import { GlobalDictation } from "../electron/global-dictation.cjs";
import { registerGlobalDictationTarget } from "../src/lib/global-dictation-target";

function mainHarness() {
	let externalStarts = 0;
	const dictation = new GlobalDictation({
		app: {},
		BrowserWindow: class {},
		globalShortcut: {},
		screen: {},
		clipboard: {},
		shell: {},
		path: {},
		request: async () => ({}),
		subscribe: () => {},
		ensureDaemon: async () => true,
	});
	dictation.begin = async () => {
		externalStarts += 1;
	};
	return { dictation, externalStarts: () => externalStarts };
}

describe("global dictation target routing", () => {
	test("routes focused and active internal sessions without starting a second capture", async () => {
		const { dictation, externalStarts } = mainHarness();
		const sent: string[] = [];
		const webContents = {
			id: 1,
			send: (channel: string) => sent.push(channel),
			once: () => {},
			isDestroyed: () => false,
		};
		const win = { webContents, isDestroyed: () => false };
		let focusedWindow: unknown = win;
		dictation.BrowserWindow = {
			getFocusedWindow: () => focusedWindow,
			getAllWindows: () => [win],
		};
		dictation.setDictationTarget({ sender: webContents }, { focused: true, active: false });
		await dictation.toggle();
		expect(sent).toEqual(["dictation:toggle"]);
		expect(externalStarts()).toBe(0);

		focusedWindow = null;
		dictation.setDictationTarget({ sender: webContents }, { focused: false, active: true });
		await dictation.toggle();
		expect(sent).toEqual(["dictation:toggle", "dictation:toggle"]);
		expect(externalStarts()).toBe(0);

		dictation.setDictationTarget({ sender: webContents }, { focused: false, active: false });
		await dictation.toggle();
		expect(externalStarts()).toBe(1);
	});

	test("delivers renderer toggles only to the focused or active editor", () => {
		const states: { focused: boolean; active: boolean }[] = [];
		let onToggle: (() => void) | null = null;
		window.electronAPI = {
			dictationTarget: {
				setState: async (state: { focused: boolean; active: boolean }) => {
					states.push(state);
				},
				onToggle: (callback: () => void) => {
					onToggle = callback;
					return () => {};
				},
			},
		} as unknown as Window["electronAPI"];
		const first = document.createElement("div");
		const second = document.createElement("div");
		first.tabIndex = 0;
		second.tabIndex = 0;
		document.body.append(first, second);
		const firstToggle = vi.fn();
		const secondToggle = vi.fn();
		let secondActive = false;
		const cleanupFirst = registerGlobalDictationTarget(first, firstToggle, () => false);
		const cleanupSecond = registerGlobalDictationTarget(second, secondToggle, () => secondActive);

		second.focus();
		onToggle?.();
		expect(secondToggle).toHaveBeenCalledTimes(1);
		expect(firstToggle).not.toHaveBeenCalled();
		expect(states.at(-1)?.focused).toBe(true);

		secondActive = true;
		first.focus();
		onToggle?.();
		expect(secondToggle).toHaveBeenCalledTimes(2);
		expect(firstToggle).not.toHaveBeenCalled();
		expect(states.at(-1)?.active).toBe(true);

		cleanupFirst();
		cleanupSecond();
		first.remove();
		second.remove();
	});
});
