/**
 * The composer's bidirectional text handling.
 *
 * A draft that mixes Chinese, Latin and right-to-left text in one line has to
 * read correctly, and the painted highlight layer has to land on the same
 * characters as the text underneath it. The overlay is a separate element
 * painting the same string over the textarea, so the two must resolve bidi
 * identically — when they disagree, every highlight lands at the wrong offset.
 *
 * The rules are read from the stylesheet because they ARE the contract: the
 * computed `unicode-bidi` value on each element is what the browser resolves
 * the text with.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(resolve(import.meta.dir, "../src/styles/gui-composer.css"), "utf8");
const mountedStyles: HTMLStyleElement[] = [];
const mountedHosts: HTMLDivElement[] = [];

afterEach(() => {
	mountedStyles.splice(0).forEach(style => style.remove());
	mountedHosts.splice(0).forEach(host => host.remove());
});

function mount(): { textarea: HTMLTextAreaElement; overlay: HTMLElement } {
	const sheet = document.createElement("style");
	mountedStyles.push(sheet);
	sheet.textContent = CSS;
	document.head.appendChild(sheet);
	const host = document.createElement("div");
	mountedHosts.push(host);
	host.innerHTML = `
		<div class="gui-composer">
			<textarea class="gui-composer-input"></textarea>
		</div>
		<div class="gui-ta-highlight gui-ta-highlight--session" id="overlay"></div>`;
	document.body.appendChild(host);
	return {
		textarea: host.querySelector<HTMLTextAreaElement>("textarea")!,
		overlay: host.querySelector<HTMLElement>("#overlay")!,
	};
}

describe("composer bidi", () => {
	it("resolves each line by its own direction", () => {
		const { textarea } = mount();
		// `plaintext` (not `embed`) makes the paragraph direction follow the
		// first strong character, and each LINE then follows its own — a line
		// that starts with Latin but contains Arabic keeps LTR base direction
		// with the Arabic run reversed inside it, which is what a reader
		// expects.
		expect(getComputedStyle(textarea).unicodeBidi).toBe("plaintext");
	});

	it("gives the highlight overlay the same rule as the textarea", () => {
		const { textarea, overlay } = mount();
		// Different rules would put the painted tokens at different offsets
		// than the text they belong to — the highlight drifts away from the
		// word it marks.
		expect(getComputedStyle(overlay).unicodeBidi).toBe(getComputedStyle(textarea).unicodeBidi);
	});

	it("keeps the box direction out of the text's hands", () => {
		const { textarea } = mount();
		// The box must NOT be dir=auto: that flips the caret and the selection
		// with the first character of the draft, which is disorienting while
		// typing.
		expect(getComputedStyle(textarea).direction).not.toBe("auto");
	});

	it("mounts beside foreign DOM for the scoped cleanup check", () => {
		const foreignStyle = document.createElement("style");
		foreignStyle.id = "composer-bidi-foreign-style";
		document.head.appendChild(foreignStyle);
		const foreignBody = document.createElement("div");
		foreignBody.id = "composer-bidi-foreign-body";
		document.body.appendChild(foreignBody);
		mount();
	});

	it("cleans only its own style and nodes after each case", () => {
		try {
			expect(document.getElementById("composer-bidi-foreign-style")).not.toBeNull();
			expect(document.getElementById("composer-bidi-foreign-body")).not.toBeNull();
			expect(document.head.querySelectorAll("style")).toHaveLength(1);
			expect(document.querySelector("textarea")).toBeNull();
		} finally {
			document.getElementById("composer-bidi-foreign-style")?.remove();
			document.getElementById("composer-bidi-foreign-body")?.remove();
		}
	});
});
