import { describe, expect, it } from "bun:test";
import { DesktopSession } from "../native/index.js";

const optInCaptureTest = Bun.env.OMP_NATIVE_DESKTOP_CAPTURE_TEST === "1" ? it : it.skip;

describe("DesktopSession", () => {
	it("exports DesktopSession from the packaged native addon", () => {
		expect(typeof DesktopSession).toBe("function");
	});

	it("reports native capability state and closes idempotently without input", async () => {
		const session = new DesktopSession({
			backend: "native",
			display: "all",
			maxWidth: 1920,
			maxHeight: 1200,
		});
		const capabilities = session.capabilities;
		expect(["quartz", "x11", "wayland", "win32", "unavailable"]).toContain(capabilities.backend);
		expect(["granted", "denied", "unknown", "unavailable"]).toContain(capabilities.capturePermission);
		expect(["granted", "denied", "unknown", "unavailable"]).toContain(capabilities.inputPermission);
		expect(typeof capabilities.capture).toBe("boolean");
		expect(typeof capabilities.input).toBe("boolean");

		await session.close();
		await session.close();
		await expect(session.capture()).rejects.toThrow("DESKTOP_SESSION_CLOSED");
	});

	it("rejects malformed GA actions before emitting native input", async () => {
		const session = new DesktopSession({ backend: "auto" });
		try {
			expect(() => session.execute([{ type: "scroll", x: 10, y: 20, scroll_x: 0 }])).toThrow(
				"DESKTOP_INVALID_ACTION",
			);
			expect(() => session.execute([{ type: "screenshot", text: "unexpected" }])).toThrow("DESKTOP_INVALID_ACTION");
		} finally {
			await session.close();
		}
	});

	optInCaptureTest("captures a real PNG with monitor geometry when display access exists", async () => {
		const session = new DesktopSession({ backend: "native", display: "all", maxWidth: 1920, maxHeight: 1200 });
		try {
			const capture = await session.capture();
			expect(Array.from(capture.data.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(capture.width).toBeGreaterThan(0);
			expect(capture.height).toBeGreaterThan(0);
			if (process.platform === "linux") {
				expect(session.capabilities.inputPermission).toBe("unknown");
				const waited = await session.execute([{ type: "wait" }]);
				expect(waited.width).toBeGreaterThan(0);
				expect(session.capabilities.inputPermission).toBe("unknown");
			}
			expect(capture.displays.length).toBeGreaterThan(0);
			for (const display of capture.displays) {
				expect(display.width).toBeGreaterThan(0);
				expect(display.height).toBeGreaterThan(0);
				expect(display.scale).toBeGreaterThan(0);
				expect(display.pixelWidth).toBeGreaterThan(0);
				expect(display.pixelHeight).toBeGreaterThan(0);
			}
		} finally {
			await session.close();
		}
	});
});
