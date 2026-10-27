import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function mountPetStyles(): void {
	const sheet = document.createElement("style");
	sheet.textContent = [
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-composer.css"), "utf8"),
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-pet.css"), "utf8"),
	].join("\n");
	document.head.appendChild(sheet);
}

function clampEndpoints(width: string): { min: number; max: number } {
	const match = width.match(/clamp\((\d+(?:\.\d+)?)px,.*,\s*(\d+(?:\.\d+)?)px\)/);
	if (!match) throw new Error(`Expected a responsive px clamp, received: ${width}`);
	return { min: Number(match[1]), max: Number(match[2]) };
}

describe("composer pet geometry", () => {
	it("keeps the brand orb prominent and legible across the responsive size range", () => {
		mountPetStyles();
		const frame = document.createElement("div");
		frame.className = "gui-composer-frame";
		const pet = document.createElement("div");
		pet.className = "gui-composer-pet";
		frame.appendChild(pet);
		document.body.appendChild(frame);

		const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules));
		const petRule = rules.find(
			rule => rule instanceof CSSStyleRule && rule.selectorText === ".gui-composer-pet" && rule.style.width,
		) as CSSStyleRule | undefined;
		expect(petRule).toBeDefined();
		const { min, max } = clampEndpoints(petRule!.style.width);
		expect(min).toBeGreaterThanOrEqual(48);
		expect(max).toBeGreaterThanOrEqual(64);
		expect(max).toBeGreaterThan(min);
		expect(petRule!.style.position).toBe("absolute");
		expect(petRule!.style.cursor).toBe("pointer");
	});

	it("does not force narrow composers into the micro face", () => {
		mountPetStyles();
		const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules));
		const narrow = rules.find(
			rule => rule instanceof CSSContainerRule && rule.conditionText === "(max-width: 380px)",
		) as CSSContainerRule | undefined;
		expect(narrow).toBeDefined();
		const petRule = Array.from(narrow!.cssRules).find(
			rule => rule instanceof CSSStyleRule && rule.selectorText === ".gui-composer-pet",
		);
		expect(petRule).toBeDefined();
		const width = (petRule as CSSStyleRule).style.width;
		const narrowFloor = width.match(/var\([^,]+,\s*(\d+(?:\.\d+)?)px\)/);
		expect(narrowFloor).not.toBeNull();
		expect(Number(narrowFloor![1])).toBeGreaterThanOrEqual(46);
	});

	it("fills the responsive click target with the orb instead of its fallback size", () => {
		mountPetStyles();
		const frame = document.createElement("div");
		frame.className = "gui-composer-frame";
		const pet = document.createElement("div");
		pet.className = "gui-composer-pet";
		const orb = document.createElement("div");
		orb.className = "gui-pet";
		orb.style.setProperty("--gui-pet-fallback", "34px");
		pet.appendChild(orb);
		frame.appendChild(pet);
		document.body.appendChild(frame);

		expect(getComputedStyle(orb).width).toBe("100%");
	});
});
