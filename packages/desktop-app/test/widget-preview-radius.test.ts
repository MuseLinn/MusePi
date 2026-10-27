import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

afterEach(() => {
	document.body.innerHTML = "";
	document.head.innerHTML = "";
});

it("nests preview radii by the preview cell padding", () => {
	const sheet = document.createElement("style");
	sheet.textContent = [
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-board.css"), "utf8"),
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-widgets.css"), "utf8"),
	].join("\n");
	document.head.appendChild(sheet);
	document.documentElement.style.setProperty("--radius-lg", "8px");
	document.documentElement.style.setProperty("--radius-sm", "4px");
	document.documentElement.style.setProperty("--radius-xl", "12px");
	const cell = document.createElement("div");
	cell.className = "gui-board-home-preview-cell";
	const fit = document.createElement("div");
	fit.className = "gui-widget-fit";
	const inner = document.createElement("div");
	inner.className = "gui-widget-fit-inner";
	const widget = document.createElement("div");
	widget.className = "gui-fx";
	inner.appendChild(widget);
	fit.appendChild(inner);
	cell.appendChild(fit);
	document.body.appendChild(cell);
	expect(getComputedStyle(cell).borderTopLeftRadius).toBe("8px");
	expect(getComputedStyle(fit).transform).not.toBe("scale(0.78)");
	expect(getComputedStyle(fit).width).toBe("100%");
	expect(getComputedStyle(widget).borderTopLeftRadius).toBe("4px");
});
