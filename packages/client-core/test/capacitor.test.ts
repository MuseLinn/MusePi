import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { isMobileShell, isNativeShell } from "../src/lib/capacitor";

GlobalRegistrator.register();

afterEach(() => {
	delete window.Capacitor;
	delete window.harmonyNative;
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

describe("native shell detection", () => {
	it("does not treat Capacitor's browser bridge as a native shell", () => {
		window.Capacitor = { isNativePlatform: () => false };
		expect(isNativeShell()).toBe(false);
		expect(isMobileShell()).toBe(false);
	});

	it("accepts the native platform bridge and HarmonyOS bridge", () => {
		window.Capacitor = { isNativePlatform: () => true };
		expect(isNativeShell()).toBe(true);
		expect(isMobileShell()).toBe(true);
		delete window.Capacitor;
		window.harmonyNative = {} as NonNullable<Window["harmonyNative"]>;
		expect(isNativeShell()).toBe(false);
		expect(isMobileShell()).toBe(true);
	});
});
