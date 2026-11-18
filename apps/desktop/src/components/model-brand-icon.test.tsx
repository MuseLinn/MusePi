import { beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelBrandIcon } from "./model-brand-icon";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		clear: () => store.clear(),
	},
	writable: true,
});

beforeEach(() => store.clear());

const render = (provider: string, modelId: string): string =>
	renderToStaticMarkup(createElement(ModelBrandIcon, { provider, modelId }));

describe("ModelBrandIcon style", () => {
	it("renders Mono by default", () => {
		const html = render("claude", "claude-sonnet-4");
		expect(html).toContain('fill="currentColor"');
	});

	it("renders a colour mark when the preference is colour", () => {
		store.set("musepi-gui-brand-icons", "color");
		const html = render("claude", "claude-sonnet-4");
		expect(html).not.toContain('fill="currentColor"');
		expect(/d="[^"]{6,}"/.test(html)).toBe(true);
	});

	it("falls back to Mono for a brand with no colour variant", () => {
		store.set("musepi-gui-brand-icons", "color");
		const html = render("opencode", "opencode-x");
		expect(html).toContain('fill="currentColor"');
	});
});
