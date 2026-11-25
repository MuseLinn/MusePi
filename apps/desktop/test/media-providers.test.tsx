/**
 * 设置 → 图像与视频生成: one compact card per provider, grouped by kind, with
 * the credential control its `authType` asks for.
 *
 * The page used to guess: built-ins shipped no auth type, so key-only
 * providers (OpenAI, Gemini…) rendered a login button and no key field. These
 * assertions feed the daemon's real wire shape — including `authType` — into
 * the section.
 */
import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaSection } from "../src/components/settings-sections/media";
import type { RpcClient } from "../src/lib/rpc";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const PROVIDERS = {
	builtin: [
		{
			id: "agnes",
			label: "Agnes",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "apiKey" as const,
			configured: true,
			description: "Requires AGNES_API_KEY",
		},
		{
			id: "openai",
			label: "OpenAI",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "apiKey" as const,
			configured: false,
			description: "Requires OPENAI_API_KEY",
		},
		{
			id: "openai-codex",
			label: "OpenAI Codex (ChatGPT)",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "oauth" as const,
			configured: false,
		},
		{
			id: "xai",
			label: "xAI Grok Imagine",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "both" as const,
			configured: false,
		},
		{
			id: "minimax",
			label: "MiniMax",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "apiKey" as const,
			configured: false,
		},
		{
			id: "meta",
			label: "Meta Muse Image",
			kind: "image" as const,
			source: "builtin" as const,
			authType: "apiKey" as const,
			configured: false,
		},
		{
			id: "agnes",
			label: "Agnes",
			kind: "video" as const,
			source: "builtin" as const,
			authType: "apiKey" as const,
			configured: true,
			models: ["agnes-video-v2.0"],
		},
	],
	extension: [
		{
			id: "studio",
			label: "Studio",
			kind: "image" as const,
			source: "extension" as const,
			authType: "apiKey" as const,
			configured: false,
			description: "Requires STUDIO_KEY",
		},
	],
};

const calls: Array<{ method: string; params: unknown }> = [];

const rpc = {
	request: async (method: string, params: unknown) => {
		calls.push({ method, params });
		if (method === "media.providers") return PROVIDERS;
		return {};
	},
} as unknown as RpcClient;

beforeEach(() => {
	calls.length = 0;
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	setLocale("en-US");
});

async function mount(): Promise<HTMLDivElement> {
	setLocale("zh-CN");
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	await act(async () => {
		root?.render(<MediaSection rpc={rpc} onLogin={() => {}} />);
	});
	host = el;
	return el;
}

function addKeyButton(row: HTMLElement): HTMLButtonElement {
	const button = [...row.querySelectorAll("button")].find(b => b.textContent === t("settings.addApiKey"));
	if (!button) throw new Error("Add key button missing");
	return button;
}

function rowFor(scope: HTMLElement, label: string): HTMLElement {
	const row = [...scope.querySelectorAll(".gui-media-provider")].find(n =>
		n.querySelector(".gui-media-provider-name")?.textContent?.includes(label),
	);
	if (!row) throw new Error(`no provider row for ${label}`);
	return row;
}

describe("media providers page", () => {
	it("groups by kind with a count and no duplicate headline copy", async () => {
		const scope = await mount();
		const groups = [...scope.querySelectorAll(".gui-media-group")].map(g => ({
			title: g.querySelector(".gui-media-group-title")?.textContent,
			count: g.querySelector(".gui-media-group-count")?.textContent,
		}));
		expect(groups).toEqual([
			{ title: t("settings.imageGenerationProviders"), count: "7" },
			{ title: t("settings.videoGenerationProviders"), count: "1" },
		]);
		expect(scope.querySelectorAll(".gui-settings-section")).toHaveLength(0);
	});

	it("puts configured providers first", async () => {
		const scope = await mount();
		const imageGroup = scope.querySelector<HTMLElement>(".gui-media-group");
		if (!imageGroup) throw new Error("image group missing");
		const rows = [...imageGroup.querySelectorAll(".gui-media-provider")];
		const configured = rows.map(r => r.classList.contains("gui-media-provider--on"));
		expect(configured[0]).toBe(true);
		expect(configured.slice(1).every(on => !on)).toBe(true);
		expect(rows[0]?.textContent).toContain("Agnes");
	});

	it("offers a key field for api-key providers, never a login", async () => {
		const scope = await mount();
		const openai = rowFor(scope, "OpenAI");
		// The entry is collapsed behind Add key: the list stays scannable.
		expect(openai.querySelector("input[type=password]")?.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		await act(async () => addKeyButton(openai).click());
		expect(openai.querySelector("input[type=password]")).not.toBeNull();
		expect(openai.textContent).not.toContain(t("settings.login"));
		// Its own localized line, not the daemon's env-var sentence.
		expect(openai.textContent).toContain(t("settings.mediaProvider.openai"));
		expect(openai.textContent).not.toContain("Requires");
	});

	it("offers login for oauth providers and both for xAI", async () => {
		const scope = await mount();
		const codex = rowFor(scope, "Codex");
		expect(codex.querySelector("input[type=password]")).toBeNull();
		expect(codex.textContent).toContain(t("settings.login"));
		expect(codex.textContent).not.toContain(t("settings.addApiKey"));

		const xai = rowFor(scope, "xAI");
		expect(xai.textContent).toContain(t("settings.login"));
		expect(xai.textContent).toContain(t("settings.addApiKey"));
	});

	it("shows a quiet remove for configured providers and saves entered keys", async () => {
		const scope = await mount();
		const agnes = rowFor(scope, "Agnes");
		expect(agnes.textContent).toContain(t("settings.configured"));
		expect(agnes.querySelector(".gui-media-remove")).not.toBeNull();

		const openai = rowFor(scope, "OpenAI");
		await act(async () => addKeyButton(openai).click());
		const input = openai.querySelector<HTMLInputElement>("input[type=password]")!;
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		act(() => {
			setter.call(input, "sk-test");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...openai.querySelectorAll("button")].find(b => b.textContent === t("general.save"))!;
		await act(async () => save.click());
		expect(calls.some(c => c.method === "providers.importApiKey")).toBe(true);
	});

	it("marks extension providers and keeps their own description", async () => {
		const scope = await mount();
		const studio = rowFor(scope, "Studio");
		expect(studio.textContent).toContain(t("settings.mediaProviderExtension"));
		expect(studio.textContent).toContain("Requires STUDIO_KEY");
	});
});
