import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

afterEach(() => {
	document.body.innerHTML = "";
	document.head.innerHTML = "";
});

function mountHome(): { home: HTMLElement; grid: HTMLElement; create: HTMLElement } {
	const sheet = document.createElement("style");
	sheet.textContent = readFileSync(resolve(import.meta.dir, "../src/styles/gui-board.css"), "utf8");
	document.head.appendChild(sheet);
	const home = document.createElement("div");
	home.className = "gui-board-home";
	const grid = document.createElement("div");
	grid.className = "gui-board-home-grid";
	const create = document.createElement("div");
	create.className = "gui-spotlight gui-board-home-create";
	home.append(grid, create);
	document.body.appendChild(home);
	return { home, grid, create };
}

describe("board home layout", () => {
	it("pins the create bar to the bottom even when collections do not fill the page", () => {
		const { home, create } = mountHome();
		expect(getComputedStyle(home).display).toBe("flex");
		expect(getComputedStyle(home).flexDirection).toBe("column");
		expect(getComputedStyle(create).marginTop).toBe("auto");
		expect(getComputedStyle(create).position).toBe("sticky");
	});

	it("uses the same minimum card height for collections and the new-board action", () => {
		const { grid } = mountHome();
		const card = document.createElement("button");
		card.className = "gui-board-home-card";
		const fresh = document.createElement("button");
		fresh.className = "gui-board-home-card gui-board-home-card--new";
		grid.append(card, fresh);
		expect(getComputedStyle(card).minHeight).toBe("300px");
		expect(getComputedStyle(fresh).minHeight).toBe("300px");
	});
});
