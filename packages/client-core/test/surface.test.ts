import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const originalWindow = globalThis.window;

function setWindow(value: unknown): void {
	Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
}

describe("surface", () => {
	beforeEach(() => {
		setWindow(undefined);
	});
	afterEach(() => {
		setWindow(originalWindow);
	});

	it("reports no mobile surface without a window", async () => {
		const { isMobileSurface, isTouchSurface, hasNativeKeyboard } = await import("../src/lib/surface.js");
		expect(isMobileSurface()).toBe(false);
		expect(isTouchSurface()).toBe(false);
		expect(hasNativeKeyboard()).toBe(false);
	});

	it("treats a coarse-pointer phone width as a mobile surface", async () => {
		setWindow({
			innerWidth: 390,
			matchMedia: (query: string) => ({ matches: query.includes("hover: none") }),
		});
		const { isMobileSurface, isTouchSurface } = await import("../src/lib/surface.js");
		expect(isTouchSurface()).toBe(true);
		expect(isMobileSurface()).toBe(true);
	});

	it("keeps a narrow desktop window on the desktop surface", async () => {
		setWindow({ innerWidth: 500, matchMedia: () => ({ matches: false }) });
		const { isMobileSurface } = await import("../src/lib/surface.js");
		expect(isMobileSurface()).toBe(false);
	});

	it("keeps a wide touch screen on the desktop surface", async () => {
		setWindow({
			innerWidth: 1280,
			matchMedia: (query: string) => ({ matches: query.includes("hover: none") }),
		});
		const { isMobileSurface } = await import("../src/lib/surface.js");
		expect(isMobileSurface()).toBe(false);
	});

	it("treats a foldable opened past the old 840px cut as a mobile surface", async () => {
		// Measured on a Huawei Pura X Max (HarmonyOS 7): `hover: none` true,
		// `pointer: coarse` FALSE (the trackpad is the primary pointer),
		// `innerWidth` 940. The old `(hover: none) and (pointer: coarse)` test
		// failed here, so the same page showed the phone layout in the shell and
		// the desktop layout in a browser.
		setWindow({
			innerWidth: 940,
			matchMedia: (query: string) => ({ matches: query.includes("hover: none") }),
		});
		const { isMobileSurface, isTouchSurface } = await import("../src/lib/surface.js");
		expect(isTouchSurface()).toBe(true);
		expect(isMobileSurface()).toBe(true);
	});

	it("reads the touch signal from hover, not from the primary pointer", async () => {
		// The foldable case: `hover: none` true, `pointer: coarse` false.
		setWindow({
			innerWidth: 940,
			matchMedia: (query: string) => ({
				matches: query.includes("(hover: none)") && !query.includes("pointer: coarse"),
			}),
		});
		const { isTouchSurface } = await import("../src/lib/surface.js");
		expect(isTouchSurface()).toBe(true);
	});

	it("does not read a coarse primary pointer as touch", async () => {
		// Measured on the HarmonyOS emulator (MusePiFold, API 26): `hover: none`
		// FALSE, `pointer: coarse` TRUE, `innerWidth` 708 — the exact inverse of
		// the real device. A pointer-based test would call that emulator a
		// finger-first screen and every desktop browser that reports a coarse
		// pointer would follow; `hover: none` is the signal both agree on.
		setWindow({
			innerWidth: 708,
			matchMedia: (query: string) => ({
				matches: query.includes("pointer: coarse") && !query.includes("hover: none"),
			}),
		});
		const { isTouchSurface } = await import("../src/lib/surface.js");
		expect(isTouchSurface()).toBe(false);
	});

	it("reserves the native keyboard for shells, not browsers", async () => {
		setWindow({
			innerWidth: 390,
			Capacitor: { isNativePlatform: () => true },
			matchMedia: () => ({ matches: true }),
		});
		const { hasNativeKeyboard } = await import("../src/lib/surface.js");
		expect(hasNativeKeyboard()).toBe(true);
	});
});
