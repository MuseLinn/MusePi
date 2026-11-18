import { beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceGlyph } from "./source-glyph";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		clear: () => store.clear(),
	},
	writable: true,
});

const SOURCES = ["omp", "pi", "opencode", "grok", "kimicode", "workbuddy", "codebuddy", "dsh", "claude", "codex"];
const render = (source: string) => renderToStaticMarkup(createElement(SourceGlyph, { source, size: 14 }));

beforeEach(() => store.clear());

describe("SourceGlyph style", () => {
	it("renders ten theme-following marks by default", () => {
		const marks = SOURCES.map(render);
		expect(marks.every(html => html.startsWith("<svg"))).toBe(true);
		expect(marks.every(html => html.includes('fill="currentColor"'))).toBe(true);
	});

	it("renders ten marks in colour mode with at least one brand colour", () => {
		store.set("musepi-gui-brand-icons", "color");
		const marks = SOURCES.map(render);
		expect(marks.every(html => html.startsWith("<svg"))).toBe(true);
		expect(marks.some(html => /fill="(?!currentColor)[^"]+"/.test(html))).toBe(true);
	});

	it("falls back to Mono for a source with no colour variant", () => {
		store.set("musepi-gui-brand-icons", "color");
		expect(render("opencode")).toContain('fill="currentColor"');
	});

	it("renders the generic bot for an unknown source", () => {
		const html = render("not-a-source");
		expect(html.length).toBeGreaterThan(0);
	});
});
