import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { VoiceStatusStrip } from "../src/components/composer/action-buttons";

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

function harness() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	const render = (phase: "recording" | "transcribing") => {
		act(() => root.render(createElement(VoiceStatusStrip, { phase, seconds: 3, level: 0.75 })));
	};
	return { host, render };
}

describe("voice status strip", () => {
	test("recording and transcribing expose distinct feedback", () => {
		const { host, render } = harness();
		render("recording");
		expect(host.querySelector(".gui-voice-strip")?.getAttribute("data-phase")).toBe("recording");
		expect(host.querySelectorAll(".gui-voice-wave i").length).toBe(13);
		expect(host.textContent).toContain("3s");

		render("transcribing");
		expect(host.querySelector(".gui-voice-strip")?.getAttribute("data-phase")).toBe("transcribing");
		expect(host.querySelector(".gui-voice-spinner")).not.toBeNull();
		expect(host.querySelector(".gui-voice-wave")).toBeNull();
		expect(host.textContent).not.toContain("3s");
		expect(host.querySelector(".gui-voice-strip-hint kbd")?.textContent).toBe("Esc");
	});

	test("carries the phase copy only — the transcript itself is painted in the composer", () => {
		const { host, render } = harness();
		render("recording");
		const copy = host.querySelector(".gui-voice-partial")?.textContent ?? "";
		expect(copy).not.toBe("");
		render("transcribing");
		expect(host.querySelector(".gui-voice-partial")?.textContent ?? "").not.toBe("");
	});
});
