/**
 * 打字效果's sample lives in the chat settings page, next to the picker that
 * selects it — the appearance page leads with its own session hero instead.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatSection } from "../src/components/settings-sections/chat";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	localStorage.clear();
	setLocale("en-US");
});

describe("typing-effect sample", () => {
	it("sits with the picker on the chat page", () => {
		setLocale("zh-CN");
		const el = document.createElement("div");
		document.body.appendChild(el);
		root = createRoot(el);
		act(() => {
			root?.render(<ChatSection />);
		});
		host = el;

		const sample = el.querySelector(".gui-typing-preview");
		expect(sample !== null).toBe(true);
		expect(sample?.querySelector(".gui-typewriter") !== null).toBe(true);
		expect(sample?.querySelector(".gui-chat-preview-label")?.textContent).toBe(t("settings.typingEffect"));
	});
});
