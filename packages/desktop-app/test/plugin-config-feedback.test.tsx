import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PluginManifestSections } from "../src/components/UnifiedPluginsView";
import type { ExtensionItem } from "../src/lib/slot-host";

const roots: Array<{ root: Root; host: HTMLElement }> = [];
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
});

function externalAgentItem(): ExtensionItem {
	return {
		id: "subagent-codex",
		extensionId: "extension-module:subagent-codex",
		kind: "extension-module",
		name: "subagent-codex",
		displayName: "Codex Subagent",
		path: "/plugins/subagent-codex/index.ts",
		source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
		state: "active",
		config: [
			{ key: "executable", type: "path", label: "Codex executable", default: "" },
			{ key: "env", type: "string", label: "Environment JSON", default: "" },
		],
	};
}

async function renderSections(request: (method: string, params: unknown) => Promise<unknown>) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => {
		root.render(createElement(PluginManifestSections, { item: externalAgentItem(), rpc: { request } as never }));
	});
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

interface InputReactProps {
	onChange(event: { target: HTMLInputElement }): void;
	onBlur(event: { target: HTMLInputElement }): void;
}

function reactProps(input: HTMLInputElement): InputReactProps {
	const key = Object.keys(input).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("input has no React props");
	return (input as unknown as Record<string, unknown>)[key] as InputReactProps;
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
		reactProps(input).onChange({ target: input });
	});
}

async function blurInput(input: HTMLInputElement): Promise<void> {
	await act(async () => reactProps(input).onBlur({ target: input }));
}

describe("external subagent config feedback", () => {
	it("detects on open and rechecks an edited executable on blur", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		await renderSections(async (method, params) => {
			calls.push({ method, params });
			if (method === "ext.call") {
				const input = params as { params: { executable: string } };
				return {
					available: true,
					path: input.params.executable || "D:/tools/codex.exe",
					version: input.params.executable ? "codex custom 2.0" : "codex 1.2.3",
				};
			}
			return {};
		});
		await flush();

		expect(document.body.textContent).toContain("codex 1.2.3");
		expect(document.body.textContent).toContain("D:/tools/codex.exe");
		const input = document.querySelector<HTMLInputElement>('input[name="executable"]')!;
		await changeInput(input, "D:/custom/codex.exe");
		await blurInput(input);
		await flush();

		expect(document.body.textContent).toContain("codex custom 2.0");
		const probeCalls = calls.filter(call => call.method === "ext.call");
		expect(probeCalls).toHaveLength(2);
		expect(probeCalls[1]?.params).toMatchObject({
			extensionId: "/plugins/subagent-codex/index.ts",
			method: "probeExecutable",
			params: { executable: "D:/custom/codex.exe" },
		});
	});

	it("shows an unavailable executable instead of implying that it works", async () => {
		await renderSections(async method => (method === "ext.call" ? { available: false, reason: "not-found" } : {}));
		await flush();

		expect(document.body.textContent).toMatch(/not found/i);
		expect(document.querySelector(".gui-plugin-config-probe")).not.toBeNull();
	});

	it("validates environment JSON on blur and clears the error while correcting it", async () => {
		await renderSections(async method =>
			method === "ext.call" ? { available: true, path: "D:/tools/codex.exe", version: "codex 1.2.3" } : {},
		);
		await flush();
		const input = document.querySelector<HTMLInputElement>('input[name="env"]')!;

		await changeInput(input, '{"TOKEN":1}');
		await blurInput(input);
		expect(document.body.textContent).toMatch(/values must be strings/i);

		await changeInput(input, '{"TOKEN":"ok"}');
		expect(document.body.textContent).not.toMatch(/values must be strings/i);
		await blurInput(input);
		expect(document.body.textContent).toMatch(/valid json/i);
	});
});
