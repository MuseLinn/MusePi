import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createFilePreviewBufferStore, type FileWorkspaceHost } from "../src/lib/file-workspace";
import { SlotComponentMount } from "../src/lib/slot-host";
import { apply } from "../src/plugins/file-workspace/index";

const globals = globalThis as typeof globalThis & {
	__fileWorkspaceProps?: {
		tabId?: string;
		dedupeKey?: string | null;
		buffers?: FileWorkspaceHost["buffers"];
	};
};

afterEach(() => {
	delete globals.__fileWorkspaceProps;
	document.body.innerHTML = "";
});

describe("file-workspace Cordis plugin", () => {
	it("registers the persistent file surface without a second workbench", () => {
		const components: ExtensionComponent[] = [];
		apply({
			setLabel() {},
			registerComponent(component: ExtensionComponent) {
				components.push(component);
			},
		} as unknown as ExtensionAPI);
		expect(components).toEqual([
			expect.objectContaining({
				slot: "panel.tab.files",
				moduleUrl: "./page.tsx",
				availability: "always",
			}),
		]);
	});

	it("passes the host-owned drafts and exact tab identity through the real slot mount", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const buffers = createFilePreviewBufferStore();
		const fileWorkspace = { buffers } as FileWorkspaceHost;
		const item = {
			slot: "panel.tab.files",
			extensionId: "/plugins/file-workspace/index.ts",
			code: `export default function Page(props) {
				globalThis.__fileWorkspaceProps = {
					tabId: props.panelTab?.id,
					dedupeKey: props.panelTab?.dedupeKey,
					buffers: props.fileWorkspace?.buffers,
				};
				return null;
			}`,
		};
		await act(async () => {
			root.render(
				createElement(SlotComponentMount, {
					item,
					rpc: null,
					fileWorkspace,
					panelTab: {
						id: "files::README.md",
						surface: "files",
						target: "README.md",
						label: "README.md",
						readOnly: false,
						dedupeKey: "files::README.md",
					},
				}),
			);
		});
		await act(async () => Bun.sleep(20));
		expect(globals.__fileWorkspaceProps).toEqual({
			tabId: "files::README.md",
			dedupeKey: "files::README.md",
			buffers,
		});
		await act(async () => root.unmount());
	});
});
