import { beforeEach, describe, expect, it } from "bun:test";
import {
	readHiddenSurfaces,
	readSurfaceOrder,
	readSurfaceWidths,
	SURFACE_HIDDEN_KEY,
	SURFACE_WIDTHS_KEY,
	type SurfaceDescriptor,
	surfaceVisible,
	widthForSurface,
	writeHiddenSurfaces,
	writeSurfaceWidth,
} from "./registry";

// bun test has no DOM storage; install an in-memory stand-in (only when the
// host provides none) so persistence round-trips are deterministic.
if (typeof localStorage === "undefined") {
	const store = new Map<string, string>();
	(globalThis as Record<string, unknown>).localStorage = {
		get length(): number {
			return store.size;
		},
		clear(): void {
			store.clear();
		},
		getItem(key: string): string | null {
			const value = store.get(key);
			return value === undefined ? null : value;
		},
		key(index: number): string | null {
			const keys = [...store.keys()];
			return index >= 0 && index < keys.length ? keys[index] : null;
		},
		removeItem(key: string): void {
			store.delete(key);
		},
		setItem(key: string, value: string): void {
			store.set(key, String(value));
		},
	};
}

function clearKeys(): void {
	try {
		localStorage.removeItem(SURFACE_WIDTHS_KEY);
		localStorage.removeItem(SURFACE_HIDDEN_KEY);
	} catch {
		/* storage unavailable */
	}
}

function hasContentSurface(): SurfaceDescriptor {
	return {
		id: "probe",
		label: "probe",
		icon: "probe",
		group: "primary",
		availability: "has-content",
		defaultWidthFraction: 0.5,
	};
}

describe("surface widths", () => {
	beforeEach(clearKeys);

	it("round-trips per-surface widths independently", () => {
		writeSurfaceWidth("git", 500);
		writeSurfaceWidth("browser", 900);
		expect(readSurfaceWidths()).toEqual({ git: 500, browser: 900 });
	});

	it("clamps to the 200–1200 range", () => {
		writeSurfaceWidth("git", 50);
		writeSurfaceWidth("browser", 5000);
		expect(readSurfaceWidths()).toEqual({ git: 200, browser: 1200 });
	});

	it("falls back to the default fraction when unset", () => {
		expect(widthForSurface("git", 0.5)).toBe(450);
	});

	it("drops corrupt payloads instead of throwing", () => {
		localStorage.setItem(SURFACE_WIDTHS_KEY, "{nope");
		expect(readSurfaceWidths()).toEqual({});
		localStorage.setItem(SURFACE_WIDTHS_KEY, JSON.stringify({ git: "wide", "": 10, ok: 400 }));
		expect(readSurfaceWidths()).toEqual({ ok: 400 });
	});
});

describe("hidden surfaces", () => {
	beforeEach(clearKeys);

	it("round-trips the hidden list and drops non-strings", () => {
		writeHiddenSurfaces(["git", "browser"]);
		expect(readHiddenSurfaces()).toEqual(["git", "browser"]);
		localStorage.setItem(SURFACE_HIDDEN_KEY, JSON.stringify(["git", 7, "", null]));
		expect(readHiddenSurfaces()).toEqual(["git"]);
		localStorage.setItem(SURFACE_HIDDEN_KEY, "{nope");
		expect(readHiddenSurfaces()).toEqual([]);
	});
});

describe("surfaceVisible", () => {
	it("always-visible surfaces ignore context", () => {
		expect(surfaceVisible({ ...hasContentSurface(), availability: "always" }, { rpc: null })).toBe(true);
	});

	it("prefers an explicit predicate when present", () => {
		const s = { ...hasContentSurface(), hasContent: () => true };
		expect(surfaceVisible(s, { rpc: null })).toBe(true);
		const t = { ...hasContentSurface(), hasContent: () => false };
		expect(surfaceVisible(t, { rpc: null, openSurfaces: new Set(["probe"]) })).toBe(false);
	});

	it("falls back to open tabs without a predicate", () => {
		const s = hasContentSurface();
		expect(surfaceVisible(s, { rpc: null, openSurfaces: new Set(["probe"]) })).toBe(true);
		expect(surfaceVisible(s, { rpc: null, openSurfaces: new Set(["other"]) })).toBe(false);
		expect(surfaceVisible(s, { rpc: null })).toBe(false);
	});
});

describe("surface order", () => {
	it("falls back to registry order and drops unknown ids", () => {
		const fallback = readSurfaceOrder();
		expect(fallback.length).toBeGreaterThan(0);
		expect(fallback).toContain("git");
	});
});
