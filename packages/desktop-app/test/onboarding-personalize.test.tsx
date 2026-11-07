import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingOverlay } from "../src/components/OnboardingOverlay";
import { BUILTIN_SVG_ID, DEFAULT_SPRITE_PET_ID } from "../src/lib/pet";
import { PET_DECOR_KEY } from "../src/lib/pet-decor";

let root: Root;
let host: HTMLDivElement;
let previousLocale: string;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	localStorage.clear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.clear();
	setLocale(previousLocale);
});

function button(label: string): HTMLButtonElement {
	const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
	if (!match) throw new Error(`Missing button: ${label}. Content: ${host.textContent}`);
	return match;
}

function showPersonalize(): void {
	act(() => {
		root.render(<OnboardingOverlay rpc={null} providerEvent={null} />);
	});
	const lastStep = host.querySelectorAll(".gui-onboarding-dot").length - 1;
	expect(lastStep).toBeGreaterThanOrEqual(0);
	act(() => {
		window.dispatchEvent(new CustomEvent("musepi-open-onboarding", { detail: { step: lastStep } }));
	});
	act(() => button("Personalize").click());
}

function petOptions(): HTMLButtonElement[] {
	return [...host.querySelectorAll<HTMLButtonElement>('.gui-obo-pet-grid [role="radio"]')];
}

describe("onboarding pet personalization", () => {
	test("picks the drawing style first, then selects within that mode", () => {
		showPersonalize();
		// The default style is vector, so the grid offers only the sphere.
		expect(petOptions()).toHaveLength(1);
		expect(petOptions()[0]?.querySelector(".gui-pet svg")).not.toBeNull();

		act(() => petOptions()[0]?.click());
		expect(localStorage.getItem("musepi-gui-pet-id")).toBe(BUILTIN_SVG_ID);
		expect(host.querySelector(".gui-obo-pers-pet .gui-pet svg")).not.toBeNull();

		// Switching style restores that mode's selection and its own grid.
		act(() => button("Spritesheet").click());
		expect(localStorage.getItem("musepi-gui-pet-id")).toBe(DEFAULT_SPRITE_PET_ID);
		expect(petOptions().length).toBeGreaterThan(1);
		expect(host.querySelector(".gui-obo-pers-pet .gui-petdex-sprite")).not.toBeNull();

		act(() => {
			petOptions()[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
			);
		});
		expect(petOptions()[1]?.getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(petOptions()[1]);
	});

	test("scopes decoration controls to the vector pet and updates both real previews", () => {
		showPersonalize();
		act(() => button("Spritesheet").click());
		expect(host.querySelector(".gui-obo-pers-decor-note")?.textContent).toContain("baked bitmap");
		for (const control of host.querySelectorAll<HTMLButtonElement>(".gui-obo-pers-decor button")) {
			expect(control.disabled).toBe(true);
		}

		act(() => button("Vector orb").click());
		act(() => petOptions()[0]?.click());
		act(() => button("Music note").click());
		expect(JSON.parse(localStorage.getItem(PET_DECOR_KEY) ?? "{}")).toMatchObject({ accessory: "note" });
		expect(petOptions()[0]?.querySelector(".gui-pet-svg__accessory")).not.toBeNull();
		expect(host.querySelector(".gui-obo-pers-pet .gui-pet-svg__accessory")).not.toBeNull();
	});

	test("shows the selected pet and a glass message bubble in desktop mode", () => {
		showPersonalize();
		act(() => petOptions()[0]?.click());
		act(() => button("On desktop").click());

		const preview = host.querySelector(".gui-obo-pers-desktop");
		expect(preview).not.toBeNull();
		expect(preview?.querySelector(".gui-obo-pers-desktop-pet .gui-pet svg")).not.toBeNull();
		expect(preview?.querySelector(".gui-obo-pers-desktop-bubble")?.textContent).toContain("1 messages total");
		expect(host.querySelector(".gui-obo-pers-composer")).toBeNull();
		expect(localStorage.getItem("musepi-gui-pet-mode")).toBe("desktop");

		act(() => button("Spritesheet").click());
		expect(preview?.querySelector(".gui-obo-pers-desktop-pet .gui-petdex-sprite")).not.toBeNull();
		expect(host.querySelector(".gui-obo-pers-desktop-bubble")).not.toBeNull();
	});
});
