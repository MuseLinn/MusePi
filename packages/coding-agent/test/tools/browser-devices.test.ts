import { describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import {
	BROWSER_DEVICE_PROFILES,
	deviceActionCode,
	resolveDeviceConfiguration,
} from "@musepi/pi-coding-agent/tools/browser/devices";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("browser device profiles", () => {
	it("lists presets and applies landscape mobile geometry", () => {
		expect(BROWSER_DEVICE_PROFILES.some(profile => profile.id === "responsive")).toBe(true);
		const configuration = resolveDeviceConfiguration({
			enabled: true,
			profileId: "iphone-14-pro",
			orientation: "landscape",
			scaleMode: "fixed",
			scale: 0.5,
		});
		expect(configuration.viewport).toEqual({
			width: 852,
			height: 393,
			deviceScaleFactor: 1,
			isMobile: true,
			hasTouch: true,
			isLandscape: true,
		});
		expect(configuration.scale).toBe(0.5);
		expect(
			deviceActionCode({
				enabled: true,
				profileId: "desktop-1440",
				orientation: "portrait",
				scaleMode: "fit",
			}),
		).toContain("page.setViewport");
	});

	it("applies responsive dimensions with mobile identity and touch", () => {
		const configuration = resolveDeviceConfiguration({
			enabled: true,
			profileId: "responsive",
			orientation: "portrait",
			scaleMode: "fit",
			width: 800,
			height: 400,
		});
		expect(configuration.viewport).toMatchObject({
			width: 800,
			height: 400,
			isMobile: true,
			hasTouch: true,
			isLandscape: false,
		});
	});

	it("clears emulation when device mode is disabled", () => {
		expect(resolveDeviceConfiguration({ enabled: false })).toEqual({ enabled: false, viewport: null });
		expect(deviceActionCode({ enabled: false })).toContain("page.setViewport(null)");
	});

	it("rejects mixed or incomplete device settings", () => {
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "responsive",
				orientation: "portrait",
				scaleMode: "fit",
			}),
		).toThrow(/width and height/);
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "iphone-se",
				orientation: "portrait",
				scaleMode: "fit",
				width: 375,
				height: 667,
			}),
		).toThrow(/presets forbid/);
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "iphone-se",
				orientation: "portrait",
				scaleMode: "fit",
				scale: 0.5,
			}),
		).toThrow(/fit forbids/);
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "iphone-se",
				orientation: "portrait",
				scaleMode: "fixed",
			}),
		).toThrow(/fixed requires/);
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "iphone-se",
				orientation: "portrait",
				scaleMode: "fixed",
				scale: Number.NaN,
			}),
		).toThrow(/fixed requires/);
		expect(() =>
			resolveDeviceConfiguration({
				enabled: true,
				profileId: "iphone-se",
				orientation: "portrait",
				scaleMode: "fixed",
				scale: Number.POSITIVE_INFINITY,
			}),
		).toThrow(/fixed requires/);
	});

	it("returns the catalog through the existing browser tool", async () => {
		const result = await new BrowserTool(makeSession()).execute("profiles", { action: "device_profiles" });
		expect(result.details?.deviceProfiles).toBe(BROWSER_DEVICE_PROFILES);
		expect(result.content.some(item => item.type === "text" && item.text.includes("iphone-14-pro"))).toBe(true);
	});
});
