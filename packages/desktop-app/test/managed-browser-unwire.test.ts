import "./happy-dom-shim";
import { afterEach, expect, test, vi } from "bun:test";
import { getHostState, unwireHost, wireHost } from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

function setElectronAPI(value: Window["electronAPI"]): void {
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value });
}

function fakeApi(): { api: Window["electronAPI"]; disposers: Array<ReturnType<typeof vi.fn>> } {
	const disposers = Array.from({ length: 5 }, () => vi.fn());
	const api = {
		onManagedBrowserState: vi.fn(() => disposers[0]),
		onManagedBrowserConfirm: vi.fn(() => disposers[1]),
		onManagedBrowserCreateTab: vi.fn(() => disposers[2]),
		onManagedBrowserSelectTab: vi.fn(() => disposers[3]),
		onManagedBrowserCloseTab: vi.fn(() => disposers[4]),
		managedBrowserGetState: vi.fn(async () => ({ port: 9235, activity: null, busyTabIds: [] })),
		managedBrowserHostReady: vi.fn(async () => ({})),
	} as unknown as Window["electronAPI"];
	return { api, disposers };
}

afterEach(() => {
	unwireHost();
	setElectronAPI(originalElectronAPI);
	vi.restoreAllMocks();
});

test("unwiring withdraws the advertised port and releases every listener", async () => {
	const { api, disposers } = fakeApi();
	setElectronAPI(api);
	const clearIntervalSpy = vi.spyOn(window, "clearInterval");

	wireHost();
	await Bun.sleep(0);
	expect(getHostState().port).toBe(9235);

	unwireHost();
	expect(getHostState().port).toBeNull();
	expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
	for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1);
});

test("a remount wires again without stacking listeners", async () => {
	const { api, disposers } = fakeApi();
	setElectronAPI(api);

	wireHost();
	await Bun.sleep(0);
	unwireHost();

	wireHost();
	await Bun.sleep(0);
	expect(getHostState().port).toBe(9235);
	expect(api?.onManagedBrowserState).toHaveBeenCalledTimes(2);
	expect(api?.onManagedBrowserConfirm).toHaveBeenCalledTimes(2);
	expect(api?.onManagedBrowserCreateTab).toHaveBeenCalledTimes(2);
	expect(api?.onManagedBrowserSelectTab).toHaveBeenCalledTimes(2);
	expect(api?.onManagedBrowserCloseTab).toHaveBeenCalledTimes(2);

	unwireHost();
	// Every wire owned one call of each disposer; the second wire released its
	// own registrations too.
	for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(2);
});

test("a snapshot that lands after unmount cannot resurrect the port", async () => {
	const { api } = fakeApi();
	let resolveState: (value: { port: number; activity: null; busyTabIds: [] }) => void = () => {};
	const apiWithPendingState = {
		...api,
		managedBrowserGetState: vi.fn(
			() =>
				new Promise<{ port: number; activity: null; busyTabIds: [] }>(resolve => {
					resolveState = resolve;
				}),
		),
	} as unknown as Window["electronAPI"];
	setElectronAPI(apiWithPendingState);

	wireHost();
	unwireHost();
	resolveState({ port: 9235, activity: null, busyTabIds: [] });
	await Bun.sleep(0);

	expect(getHostState().port).toBeNull();
});
