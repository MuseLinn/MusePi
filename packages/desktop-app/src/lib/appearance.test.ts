import { describe, expect, it } from "bun:test";
import {
	applyTerminalFont,
	applyTranscriptFont,
	DEFAULT_TERMINAL_FONT,
	DEFAULT_TRANSCRIPT_FONT,
	readTimeFormat,
	readWeekStart,
	resolveHour12,
	TERMINAL_FONT_OPTIONS,
	timeFormatOptions,
	weekStartIndex,
} from "./appearance";

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

/** Install a minimal localStorage over the given entries (bun has no DOM). */
function withStorage(entries: Record<string, string>): void {
	const data = new Map(Object.entries(entries));
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value),
			removeItem: (key: string) => void data.delete(key),
		},
	});
}

/**
 * 设置 → 外观 → 时间格式 / 一周起始日: the stored value is the option id,
 * never an i18n key. A build that kept `general.auto` in state rendered the
 * raw key in the dropdown and made every resolver miss; the readers must
 * normalize such leftovers instead of returning them.
 */
describe("readTimeFormat", () => {
	it("returns null when unset so the caller falls back to its default", () => {
		withStorage({});
		expect(readTimeFormat()).toBeNull();
	});

	it("reads the stored option id", () => {
		withStorage({ "musepi-gui-timefmt": "12h" });
		expect(readTimeFormat()).toBe("12h");
	});

	it("normalizes a legacy i18n-key value to its option id", () => {
		withStorage({ "musepi-gui-timefmt": "general.auto" });
		expect(readTimeFormat()).toBe("auto");
	});

	it("rejects unknown values instead of surfacing them", () => {
		withStorage({ "musepi-gui-timefmt": "general.bogus" });
		expect(readTimeFormat()).toBeNull();
	});
});

describe("readWeekStart / weekStartIndex", () => {
	it("maps the stored id to a weekday index", () => {
		withStorage({ "musepi-gui-weekstart": "sunday" });
		expect(readWeekStart()).toBe("sunday");
		expect(weekStartIndex()).toBe(0);

		withStorage({ "musepi-gui-weekstart": "monday" });
		expect(weekStartIndex()).toBe(1);
	});

	it("treats the unset pref as Monday (zh-CN) rather than failing", () => {
		withStorage({});
		expect(weekStartIndex()).toBe(1);
	});

	it("normalizes a legacy i18n-key value so the week start still applies", () => {
		withStorage({ "musepi-gui-weekstart": "general.sunday" });
		expect(readWeekStart()).toBe("sunday");
		expect(weekStartIndex()).toBe(0);
	});
});

/** Minimal CSS-variable target (bun has no DOM). */
function styleRoot(): { props: Map<string, string>; root: HTMLElement } {
	const props = new Map<string, string>();
	return {
		props,
		root: { style: { setProperty: (key: string, value: string) => props.set(key, value) } } as unknown as HTMLElement,
	};
}

describe("applyTranscriptFont / applyTerminalFont", () => {
	it("writes the picked stack to its own variable", () => {
		const { props, root } = styleRoot();
		applyTranscriptFont(DEFAULT_TRANSCRIPT_FONT.id, root);
		applyTerminalFont(TERMINAL_FONT_OPTIONS[1]?.id ?? null, root);

		expect(props.get("--font-transcript")).toBe(DEFAULT_TRANSCRIPT_FONT.stack);
		expect(props.get("--font-terminal")).toBe(TERMINAL_FONT_OPTIONS[1]?.stack);
	});

	it("falls back to the default option for an unknown id", () => {
		const { props, root } = styleRoot();
		applyTerminalFont("missing", root);
		expect(props.get("--font-terminal")).toBe(DEFAULT_TERMINAL_FONT.stack);
	});
});
