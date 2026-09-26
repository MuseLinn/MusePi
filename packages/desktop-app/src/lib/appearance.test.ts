import { describe, expect, it } from "bun:test";
import { resolveHour12, timeFormatOptions } from "./appearance";

/**
 * 设置 → 外观 → 时间格式 (TIME_FMT_KEY): the render layer must honor the
 * preference instead of the historical hard-coded `hour12: false`. The
 * unset pref (and "auto") must keep the historical 24h behavior.
 */
describe("resolveHour12", () => {
	it("keeps the historical 24h rendering for the unset pref and 'auto'", () => {
		expect(resolveHour12(null)).toBe(false);
		expect(resolveHour12(undefined)).toBe(false);
		expect(resolveHour12("auto")).toBe(false);
		expect(resolveHour12("24h")).toBe(false);
	});

	it("switches to 12-hour only for the explicit '12h' pick", () => {
		expect(resolveHour12("12h")).toBe(true);
	});
});

describe("timeFormatOptions", () => {
	it("carries the resolved hour12 alongside caller options (pref passed explicitly)", () => {
		expect(timeFormatOptions({ hour: "2-digit", minute: "2-digit" }, "12h")).toEqual({
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		});
		expect(timeFormatOptions({ second: "2-digit" }, "24h")).toEqual({ second: "2-digit", hour12: false });
	});

	it("does not let caller options override the resolved hour12", () => {
		// The whole point of the helper: stray hard-coded hour12 in extra
		// must not resurrect the old always-24h behavior.
		expect(timeFormatOptions({ hour12: false }, "12h").hour12).toBe(true);
	});
});
