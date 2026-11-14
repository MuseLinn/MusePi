import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createFilePreviewBufferStore, type FileWorkspaceHost } from "../src/lib/file-workspace";
import { fileRootSelection } from "../src/lib/workspace-roots";
import FileWorkspacePage from "../src/plugins/file-workspace/page";

const mounted = new Set<Root>();

async function flush(frames = 4): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	fileRootSelection.clear();
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

interface Recorded {
	method: string;
	params: unknown;
}

function rpcStub(options: {
	directories: Record<string, Array<{ path: string; primary: boolean; exists: boolean }>>;
	calls: Recorded[];
}): { request<T = unknown>(method: string, params?: unknown): Promise<T> } {
	return {
		async request<T>(method: string, params?: unknown): Promise<T> {
			options.calls.push({ method, params });
			switch (method) {
				case "session.directories.list": {
					const sessionId = (params as { sessionId: string }).sessionId;
					return { directories: options.directories[sessionId] ?? [] } as T;
				}
				case "workspace.tree":
					return { entries: [], truncated: false } as T;
				case "artifact.list":
					return { artifacts: [] } as T;
				default:
					throw new Error(`unexpected RPC: ${method}`);
			}
		},
	};
}

function host(): FileWorkspaceHost {
	return {
		buffers: createFilePreviewBufferStore(),
		openRequest: null,
		openFile() {},
		setDirty() {},
		closeTab() {},
		canNavigateBack: false,
		canNavigateForward: false,
		navigateHistory: () => null,
		onEditorNavigate() {},
		onEditorPositionChange() {},
	};
}

function page(
	rpc: { request<T = unknown>(method: string, params?: unknown): Promise<T> },
	sessionId: string,
	cwd: string,
) {
	return createElement(FileWorkspacePage, {
		rpc: rpc as never,
		cwd,
		sessionId,
		panelTab: {
			id: "files::",
			surface: "files",
			target: null,
			label: "Files",
			readOnly: false,
		},
		fileWorkspace: host(),
	});
}

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return { container, root };
}

function treeRoots(calls: Recorded[]): string[] {
	return calls.filter(call => call.method === "workspace.tree").map(call => (call.params as { cwd: string }).cwd);
}

describe("file workspace roots", () => {
	it("offers the session's additional directories and re-reads the tree from the chosen one", async () => {
		const calls: Recorded[] = [];
		const rpc = rpcStub({
			directories: {
				s1: [
					{ path: "/work/primary", primary: true, exists: true },
					{ path: "/work/shared", primary: false, exists: true },
				],
			},
			calls,
		});
		const { container } = await mount(page(rpc, "s1", "/work/primary"));
		expect(treeRoots(calls)).toEqual(["/work/primary"]);

		const trigger = container.querySelector<HTMLButtonElement>(".gui-filepane-path-root");
		expect(trigger).not.toBeNull();
		await act(async () => trigger?.click());
		const shared = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
			item.textContent?.includes("shared"),
		);
		expect(shared).toBeDefined();
		await act(async () => shared?.click());
		await flush();

		expect(treeRoots(calls).at(-1)).toBe("/work/shared");
	});

	it("does not inherit another session's root choice", async () => {
		const calls: Recorded[] = [];
		const rpc = rpcStub({
			directories: {
				s1: [
					{ path: "/work/one", primary: true, exists: true },
					{ path: "/work/shared", primary: false, exists: true },
				],
				s2: [{ path: "/work/two", primary: true, exists: true }],
			},
			calls,
		});
		fileRootSelection.set("session:s1", "/work/shared");
		const { container, root } = await mount(page(rpc, "s1", "/work/one"));
		await flush();
		expect(treeRoots(calls).at(-1)).toBe("/work/shared");

		calls.length = 0;
		await act(async () => root.render(page(rpc, "s2", "/work/two")));
		await flush();
		expect(container.textContent).toContain("two");
		expect(treeRoots(calls).every(rootPath => rootPath === "/work/two")).toBe(true);
	});

	it("hides the root switcher when the session has a single working directory", async () => {
		const calls: Recorded[] = [];
		const rpc = rpcStub({
			directories: { s1: [{ path: "/work/only", primary: true, exists: true }] },
			calls,
		});
		const { container } = await mount(page(rpc, "s1", "/work/only"));
		expect(container.querySelector<HTMLButtonElement>("button.gui-filepane-path-root")).toBeNull();
	});
});
