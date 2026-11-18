import { beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelBrandIcon } from "./model-brand-icon";
import { SourceGlyph } from "./source-glyph";

const store = new Map<string, string>();
const listeners = new Set<() => void>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		clear: () => store.clear(),
	},
	writable: true,
});
Object.defineProperty(globalThis, "window", {
	value: {
		addEventListener: (type: string, listener: () => void) => {
			if (type === "musepi-gui-brand-icons-changed") listeners.add(listener);
		},
		removeEventListener: (type: string, listener: () => void) => {
			if (type === "musepi-gui-brand-icons-changed") listeners.delete(listener);
		},
		dispatchEvent: () => {
			for (const listener of listeners) listener();
			return true;
		},
	},
	writable: true,
});

beforeEach(() => {
	store.clear();
	listeners.clear();
});

const render = () => ({
	model: renderToStaticMarkup(createElement(ModelBrandIcon, { provider: "claude", modelId: "claude-x" })),
	source: renderToStaticMarkup(createElement(SourceGlyph, { source: "claude", size: 14 })),
});

describe("brand icon preference is global", () => {
	it("switches both mounted icon families on one change event", () => {
		const before = render();
		expect(before.model).toContain('fill="currentColor"');
		expect(before.source).toContain('fill="currentColor"');

		store.set("musepi-gui-brand-icons", "color");
		for (const listener of listeners) listener();

		const after = render();
		expect(after.model).not.toContain('fill="currentColor"');
		expect(after.source).not.toContain('fill="currentColor"');
	});
});
