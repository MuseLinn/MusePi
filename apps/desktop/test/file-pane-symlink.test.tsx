import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { filePreviewBuffers, type WorkspaceEntry } from "../src/lib/file-workspace";
import type { RpcClient } from "../src/lib/rpc";
import { FilePane } from "../src/plugins/file-workspace/FilePane";

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

async function settle(): Promise<void> {
	await act(async () => {
		await Bun.sleep(5);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await settle();
	}
	throw new Error("condition did not become true");
}

const symlinkEntries: WorkspaceEntry[] = [
	{
		path: "link-dir",
		name: "link-dir",
		isDir: true,
		isSymlink: true,
		linkTarget: "/workspace/real",
		size: 0,
		mtime: 0,
		depth: 1,
	},
	{ path: "link-dir/child.md", name: "child.md", isDir: false, size: 3, mtime: 0, depth: 2 },
	{
		path: "link-out",
		name: "link-out",
		isDir: false,
		isSymlink: true,
		linkTarget: "/outside/secret",
		size: 0,
		mtime: 0,
		depth: 1,
	},
];

function mockRpc(entries: WorkspaceEntry[]): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "workspace.tree") return { entries };
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function renderPane(rpc: RpcClient): Promise<{ container: HTMLDivElement; opens: string[] }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	const opens: string[] = [];
	await act(async () =>
		root.render(
			<FilePane
				bufferStore={filePreviewBuffers}
				rpc={rpc}
				cwd="/workspace"
				activeFile={null}
				onOpenFile={path => opens.push(path)}
			/>,
		),
	);
	await waitFor(() => container.querySelector(".gui-filepane-row") !== null);
	return { container, opens };
}

describe("FilePane symlinked directory rows", () => {
	it("marks links and expands a followed directory through the collapse state", async () => {
		const { container } = await renderPane(mockRpc(symlinkEntries));
		const badges = Array.from(container.querySelectorAll<HTMLElement>(".gui-filepane-symlink"));

		expect(badges.length).toBe(2);
		expect(badges[0]?.getAttribute("title")).toContain("/workspace/real");
		expect(badges[1]?.getAttribute("title")).toContain("/outside/secret");

		// Collapsed by default: the linked directory's child is not visible yet.
		expect(container.textContent).not.toContain("child.md");
		const dirRow = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".gui-filepane-dir .gui-filepane-row"),
		).find(button => button.textContent?.includes("link-dir"));
		expect(dirRow).toBeDefined();
		await act(async () => dirRow?.click());
		await waitFor(() => container.textContent?.includes("child.md") === true);
	});

	it("still opens a symlinked file as a file instead of expanding it", async () => {
		const { container, opens } = await renderPane(mockRpc(symlinkEntries));
		const fileRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".gui-filepane-row")).find(button =>
			button.textContent?.includes("link-out"),
		);

		expect(fileRow).toBeDefined();
		expect(fileRow?.closest("li")?.classList.contains("gui-filepane-dir")).toBe(false);
		await act(async () => fileRow?.click());
		expect(opens).toEqual(["link-out"]);
	});
});
