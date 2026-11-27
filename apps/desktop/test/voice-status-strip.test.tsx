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
		const host = render(createElement(VoiceStatusStrip, { phase: "recording" }));
		// The mic capsule already pulses and already shows the level, and the
		// transcript is painted at the caret: a second orb, rings or a 13-bar wave
		// here would restate the same two facts within 40px.
		expect(host.querySelector(".gui-voice-visual")).toBeNull();
		expect(host.querySelector(".gui-voice-ring")).toBeNull();
		expect(host.querySelector(".gui-voice-wave")).toBeNull();
		// "recognized text will appear here" stopped being true once it does.
		expect(host.querySelector(".gui-voice-partial")).toBeNull();
	});

	test("transcribing keeps a settled, non-pulsing line for the whole wait", () => {
		const host = render(createElement(VoiceStatusStrip, { phase: "transcribing" }));
		const strip = host.querySelector(".gui-voice-strip");
		expect(strip?.getAttribute("data-phase")).toBe("transcribing");
		// Transcribing is a wait, not a live capture: the dot stops pulsing.
		expect(host.querySelector(".gui-voice-dot")).not.toBeNull();
		expect(host.querySelector(".gui-voice-strip-label")?.textContent).not.toBe("");
	});
});

describe("voice mic capsule", () => {
	test("recording carries the clock and the input level inside the control", () => {
		const host = render(
			createElement(VoiceButton, { state: "recording", seconds: 7, level: 0.42, onToggle: () => {} }),
		);
		const button = host.querySelector<HTMLButtonElement>("button");
		expect(button?.className).toContain("gui-composer-ico--dictating");
		expect(host.querySelector(".gui-voice-seconds")?.textContent).toBe("7s");
		// The level bar is scoped to the button, so the value cannot drift from
		// the control it describes.
		expect(host.querySelector<HTMLElement>(".gui-voice-level")?.style.width).toBe("42%");
	});

	test("idle carries neither, so the resting composer gains no counters", () => {
		const host = render(createElement(VoiceButton, { state: "idle", onToggle: () => {} }));
		expect(host.querySelector(".gui-voice-seconds")).toBeNull();
		expect(host.querySelector(".gui-voice-level")).toBeNull();
	});

	test("transcribing shows a spinner instead of a second countdown", () => {
		const host = render(createElement(VoiceButton, { state: "transcribing", onToggle: () => {} }));
		expect(host.querySelector(".gui-voice-spinner")).not.toBeNull();
		expect(host.querySelector(".gui-voice-seconds")).toBeNull();
	});
});
