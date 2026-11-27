import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { VoiceButton, VoiceStatusStrip } from "../src/components/composer/action-buttons";

const originalLocale = getLocaleSnapshot();
const mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> }[] = [];

beforeEach(() => setLocale("en-US"));
afterEach(() => {
	for (const { host, root } of mounted.splice(0)) {
		act(() => root.unmount());
		host.remove();
	}
	setLocale(originalLocale);
});

function render(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	act(() => root.render(node));
	return host;
}

describe("voice status strip", () => {
	test("states the phase in one line and keeps the cancel affordance", () => {
		const host = render(createElement(VoiceStatusStrip, { phase: "recording" }));
		const strip = host.querySelector(".gui-voice-strip");
		expect(strip?.getAttribute("data-phase")).toBe("recording");
		expect(host.querySelector(".gui-voice-dot")).not.toBeNull();
		expect(host.querySelector(".gui-voice-strip-label")?.textContent).not.toBe("");
		expect(host.querySelector(".gui-voice-strip-hint kbd")?.textContent).toBe("Esc");
		expect(strip?.getAttribute("role")).toBe("status");
	});

	test("carries no second mic, no second level meter and no stale hint", () => {
		const host = render(createElement(VoiceStatusStrip, { phase: "recording", seconds: 4, level: 0.5 }));
		// The transcript is painted at the caret: a second orb, rings or a 13-bar
		// wave here would restate the same facts within 40px.
		expect(host.querySelector(".gui-voice-visual")).toBeNull();
		expect(host.querySelector(".gui-voice-ring")).toBeNull();
		expect(host.querySelector(".gui-voice-wave")).toBeNull();
		// "recognized text will appear here" stopped being true once it does.
		expect(host.querySelector(".gui-voice-partial")).toBeNull();
	});

	test("carries the clock and exactly one meter, both in the strip", () => {
		const host = render(createElement(VoiceStatusStrip, { phase: "recording", seconds: 4, level: 0.5 }));
		expect(host.querySelector(".gui-voice-strip-time")?.textContent).toBe("4s");
		// One meter, scaled by the real RMS.
		expect(host.querySelectorAll(".gui-voice-meter").length).toBe(1);
		expect(host.querySelector<HTMLElement>(".gui-voice-meter > i")?.style.width).toBe("50%");
	});

	test("transcribing keeps the strip for the wait but drops the meter", () => {
		const host = render(createElement(VoiceStatusStrip, { phase: "transcribing", seconds: 4, level: 0.5 }));
		const strip = host.querySelector(".gui-voice-strip");
		expect(strip?.getAttribute("data-phase")).toBe("transcribing");
		expect(host.querySelector(".gui-voice-dot")).not.toBeNull();
		expect(host.querySelector(".gui-voice-strip-label")?.textContent).not.toBe("");
		// Nothing is being captured: a live meter would claim otherwise, and a
		// running clock would describe a recording that already ended.
		expect(host.querySelector(".gui-voice-meter")).toBeNull();
		expect(host.querySelector(".gui-voice-strip-time")).toBeNull();
	});
});

describe("voice mic button", () => {
	test("recording is a state icon only — no capsule, clock or meter", () => {
		const host = render(createElement(VoiceButton, { state: "recording", onToggle: () => {} }));
		const button = host.querySelector<HTMLButtonElement>("button");
		expect(button?.className).toContain("gui-composer-ico--dictating");
		expect(button?.dataset.state).toBe("recording");
		// The clock and the meter live in the dictation strip. An expanding
		// capsule here was tried, reverted, and must not come back.
		expect(host.querySelector(".gui-voice-seconds")).toBeNull();
		expect(host.querySelector(".gui-voice-level")).toBeNull();
	});

	test("idle carries no state tint", () => {
		const host = render(createElement(VoiceButton, { state: "idle", onToggle: () => {} }));
		expect(host.querySelector<HTMLButtonElement>("button")?.className).not.toContain("--dictating");
		expect(host.querySelector<HTMLButtonElement>("button")?.dataset.state).toBe("idle");
	});

	test("transcribing shows a spinner instead of a second countdown", () => {
		const host = render(createElement(VoiceButton, { state: "transcribing", onToggle: () => {} }));
		expect(host.querySelector(".gui-voice-spinner")).not.toBeNull();
		expect(host.querySelector(".gui-voice-seconds")).toBeNull();
	});
});
