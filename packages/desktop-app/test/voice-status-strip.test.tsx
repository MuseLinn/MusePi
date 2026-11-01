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
	const render = (phase: "recording" | "transcribing", partialText = "") => {
		act(() => root.render(createElement(VoiceStatusStrip, { phase, seconds: 3, level: 0.75, partialText })));
	};
	return { host, render };
}

describe("voice status strip", () => {
	test("recording and transcribing expose distinct feedback without losing the live preview", () => {
		const { host, render } = harness();
		render("recording", "hello");
		expect(host.querySelector(".gui-voice-strip")?.getAttribute("data-phase")).toBe("recording");
		expect(host.querySelectorAll(".gui-voice-wave i").length).toBe(13);
		expect(host.querySelector(".gui-voice-partial")?.textContent).toBe("hello");
		expect(host.textContent).toContain("3s");

		render("transcribing", "hello");
		expect(host.querySelector(".gui-voice-strip")?.getAttribute("data-phase")).toBe("transcribing");
		expect(host.querySelector(".gui-voice-spinner")).not.toBeNull();
		expect(host.querySelector(".gui-voice-wave")).toBeNull();
		expect(host.querySelector(".gui-voice-partial")?.textContent).toBe("hello");
		expect(host.textContent).not.toContain("3s");
		expect(host.querySelector(".gui-voice-strip-hint kbd")?.textContent).toBe("Esc");
	});

	test("an empty preview still explains the current phase", () => {
		const { host, render } = harness();
		render("recording");
		expect(host.querySelector(".gui-voice-partial")?.textContent).not.toBe("");
		render("transcribing");
		expect(host.querySelector(".gui-voice-partial")?.textContent).not.toBe("");
	});
});
