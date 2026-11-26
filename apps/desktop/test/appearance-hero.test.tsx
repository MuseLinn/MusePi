/**
 * 设置 → 外观 opens on the session itself: a hero card that carries the real
 * capsule / transcript rows / composer, so the page answers "what will this
 * look like" before it lists the switches that change it. The theme rows come
 * first under it, and the separate 效果预览 section is gone — a second copy of
 * the same sample below the fold was the page's largest redundancy.
 */
import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AppearanceSettingsPage from "../src/plugins/ui-settings-appearance/page";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	localStorage.clear();
	setLocale("en-US");
});

function mount(locale: "zh-CN" | "en-US" = "zh-CN"): HTMLDivElement {
	setLocale(locale);
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => {
		root?.render(<AppearanceSettingsPage showAvatars onToggleAvatars={() => {}} rpc={null} />);
	});
	host = el;
	return el;
}

describe("appearance hero", () => {
	it("renders the session card inside the app shell", () => {
		const scope = mount();
		const hero = scope.querySelector(".gui-appearance-hero .gui-effect-preview--session");
		if (!hero) throw new Error("hero session card missing");
		expect(hero.querySelector(".gui-agent-capsule") !== null).toBe(true);
		expect(hero.querySelector(".gui-effect-preview-composer") !== null).toBe(true);
		expect(hero.querySelectorAll(".tr-row").length).toBeGreaterThan(0);

		// The shell is the real app chrome: left rail + chat card + right rail,
		// inert so the preview cannot be clicked or tabbed into.
		const shell = scope.querySelector(".gui-appearance-hero-window");
		expect(shell?.hasAttribute("inert")).toBe(true);
		expect(shell?.querySelector(".gui-rail") !== null).toBe(true);
		expect(shell?.querySelector(".gui-right-rail") !== null).toBe(true);

		const firstSection = scope.querySelector(".gui-settings-section");
		expect(hero.compareDocumentPosition(firstSection!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("starts the settings at the theme and drops the duplicate preview", () => {
		const scope = mount();
		const titles = [...scope.querySelectorAll(".gui-settings-section-title")].map(n => n.textContent);
		expect(titles[0]).toBe(t("settings.theme"));
		expect(titles).not.toContain(t("general.effectsPreview"));
		expect(scope.querySelectorAll(".gui-effect-preview--session")).toHaveLength(1);
	});

	it("shows the resting activity fold, like a finished turn", () => {
		const scope = mount();
		const hero = scope.querySelector(".gui-effect-preview--session");
		expect(hero?.querySelector(".tr-round-fold") !== null).toBe(true);
		expect(hero?.querySelector(".tr-activity-preview-rows") === null).toBe(true);
	});
});
