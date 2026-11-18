import { beforeEach, describe, expect, it } from "bun:test";
import { readBrandIconStyle, subscribeBrandIconStyle, writeBrandIconStyle } from "./brand-icon-style";

const store = new Map<string, string>();
const listeners = new Set<() => void>();
const localStorageMock = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	clear: () => store.clear(),
};
const windowMock = {
	addEventListener: (type: string, listener: () => void) => {
		if (type === "musepi-gui-brand-icons-changed") listeners.add(listener);
	},
	removeEventListener: (type: string, listener: () => void) => {
		if (type === "musepi-gui-brand-icons-changed") listeners.delete(listener);
	},
	dispatchEvent: (event: { type: string }) => {
		if (event.type === "musepi-gui-brand-icons-changed") for (const listener of listeners) listener();
		return true;
	},
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });
Object.defineProperty(globalThis, "window", { value: windowMock, writable: true });

beforeEach(() => {
	store.clear();
	listeners.clear();
});

describe("brand icon style", () => {
	it("defaults to mono when unset", () => {
		expect(readBrandIconStyle()).toBe("mono");
	});

	it("falls back to mono on a junk stored value", () => {
		localStorage.setItem("musepi-gui-brand-icons", "rainbow");
		expect(readBrandIconStyle()).toBe("mono");
	});

	it("reads a stored colour preference", () => {
		localStorage.setItem("musepi-gui-brand-icons", "color");
		expect(readBrandIconStyle()).toBe("color");
	});

	it("notifies subscribers once and stops after disposal", () => {
		let calls = 0;
		const listener = () => {
			calls += 1;
		};
		let events = 0;
		const eventListener = () => {
			events += 1;
		};
		window.addEventListener("musepi-gui-brand-icons-changed", eventListener);
		const dispose = subscribeBrandIconStyle(listener);

		writeBrandIconStyle("color");
		expect(calls).toBe(1);
		expect(events).toBe(1);

		dispose();
		writeBrandIconStyle("mono");
		expect(calls).toBe(1);
		expect(events).toBe(2);
		window.removeEventListener("musepi-gui-brand-icons-changed", eventListener);
	});
});
