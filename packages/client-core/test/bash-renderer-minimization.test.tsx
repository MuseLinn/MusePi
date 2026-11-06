import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "../src/i18n";
import { bashRenderer } from "../src/tool-render/tools/bash";
import type { ToolRenderHost } from "../src/tool-render/types";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
setLocale("en-US");
afterAll(() => void GlobalRegistrator.unregister());

const roots: Root[] = [];
afterEach(() => {
	while (roots.length) act(() => roots.pop()!.unmount());
	document.body.innerHTML = "";
});

function mount(node: ReactNode): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return host;
}

function result(minimization: Record<string, unknown>) {
	return {
		content: [
			{
				type: "text",
				text: minimization.artifactId ? "filtered\n[raw output: artifact://42]\n" : "filtered\n",
			},
		],
		details: { minimization },
	};
}

const Body = bashRenderer.Body!;

describe("Bash minimization renderer", () => {
	test("shows measured savings and opens the raw artifact through the host", () => {
		const opened: string[] = [];
		const hostCapabilities: ToolRenderHost = { openArtifact: id => opened.push(id) };
		const host = mount(
			createElement(Body, {
				name: "bash",
				args: { command: "git status" },
				result: result({ filter: "git", inputBytes: 1000, outputBytes: 250, artifactId: "42" }),
				host: hostCapabilities,
			}),
		);
		expect(host.textContent).toContain("75.0%");
		expect(host.textContent).toContain("git");
		const button = [...host.querySelectorAll("button")].find(item => item.textContent === "View raw output");
		expect(button).toBeDefined();
		act(() => button!.click());
		expect(opened).toEqual(["42"]);
	});

	test("keeps the artifact id but hides the action without host capability", () => {
		const host = mount(
			createElement(Body, {
				name: "bash",
				args: { command: "git status" },
				result: result({ filter: "git", inputBytes: 1000, outputBytes: 250, artifactId: "42" }),
			}),
		);
		expect(host.textContent).toContain("Artifact 42");
		expect(host.textContent).not.toContain("View raw output");
	});

	test("hides the action when no raw artifact was persisted", () => {
		const host = mount(
			createElement(Body, {
				name: "bash",
				args: { command: "git status" },
				result: result({ filter: "git", inputBytes: 1000, outputBytes: 250 }),
				host: { openArtifact: () => {} },
			}),
		);
		expect(host.textContent).not.toContain("View raw output");
	});
});
