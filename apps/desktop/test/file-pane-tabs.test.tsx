import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	discardFilePreviewBuffer,
	filePreviewBuffers,
	filePreviewPathEquals,
	filePreviewWorkspacePath,
	restoreFilePreviewBuffer,
	stashFilePreviewBuffer,
} from "../src/lib/file-workspace";
import * as monacoLsp from "../src/lib/monaco-lsp";
import type { RpcClient } from "../src/lib/rpc";
import { buildTree, FilePane, type WorkspaceEntry } from "../src/plugins/file-workspace/FilePane";

const mounted = new Set<Root>();
const treeEntry: WorkspaceEntry = { path: "a.txt", name: "a.txt", isDir: false, size: 1, mtime: 0, depth: 1 };

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

function textResponse(text: string): { base64: string; size: number; mime: string } {
	return { base64: btoa(text), size: text.length, mime: "text/plain" };
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("FilePane tree assembly", () => {
	const entry = (path: string, isDir: boolean): WorkspaceEntry => ({
		path,
		name: path.split("/").at(-1) ?? path,
		isDir,
		size: 0,
		mtime: 0,
		depth: path.split("/").length,
	});

	it("does not promote descendants of truncated or hidden parents into the root", () => {
		const roots = buildTree([
			entry("vscode", true),
			entry("vscode/extensions", true),
			entry("vscode/extensions/snippets", true),
			entry("orphan/syntaxes", true),
			entry("orphan/syntaxes", true),
			entry("orphan/syntaxes/json.json", false),
		]);
		expect(roots.map(node => node.entry.path)).toEqual(["vscode"]);
		expect(roots[0]?.children[0]?.children.map(node => node.entry.path)).toEqual(["vscode/extensions/snippets"]);
	});

	it("attaches direct children to a selected directory browsing root", () => {
		const roots = buildTree(
			[entry("docs/guide.md", false), entry("docs/assets", true), entry("docs/assets/logo.svg", false)],
			"docs",
		);
		expect(roots.map(node => node.entry.path)).toEqual(["docs/assets", "docs/guide.md"]);
		expect(roots[0]?.children.map(node => node.entry.path)).toEqual(["docs/assets/logo.svg"]);
	});
});

describe("FilePane panel tab opening", () => {
	let clipboardDescriptor: PropertyDescriptor | undefined;
	beforeEach(() => {
		clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
	});
	afterEach(() => {
		if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
	});

	it("lets the tree register a preview without reading, then loads the active file tab once", async () => {
		const reads: string[] = [];
		const opens: Array<{ path: string; pin?: boolean }> = [];
		const rpc = {
			request: async (method: string, args?: { path?: string }) => {
				if (method === "workspace.tree") return { entries: [treeEntry] };
				if (method === "fs.readBytes") {
					reads.push(args?.path ?? "");
					return textResponse("alpha");
				}
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		const pane = (activeFile: string | null) => (
			<FilePane
				bufferStore={filePreviewBuffers}
				key={activeFile ?? "tree"}
				rpc={rpc}
				cwd="/workspace"
				activeFile={activeFile}
				onOpenFile={(path, _name, options) => opens.push({ path, pin: options?.pin })}
			/>
		);
		await act(async () => root.render(pane(null)));
		await waitFor(() => container.querySelector(".gui-filepane-row") !== null);

		await act(async () => container.querySelector<HTMLButtonElement>(".gui-filepane-row")?.click());
		expect(opens).toEqual([{ path: "a.txt", pin: false }]);
		expect(reads).toEqual([]);

		await act(async () => root.render(pane("a.txt")));
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		expect(reads).toEqual(["/workspace/a.txt"]);

		await act(async () => root.render(pane(null)));
		await waitFor(() => container.querySelector(".gui-filepane-row") !== null);
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>(".gui-filepane-row")
				?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })),
		);
		expect(opens.at(-1)).toEqual({ path: "a.txt", pin: true });
	});

	it("keeps the current file open while its inline tree opens another file in a new tab", async () => {
		const opens: Array<{ path: string; pin: boolean; newTab: boolean }> = [];
		const rpc = {
			request: async (method: string) => {
				if (method === "workspace.tree") {
					return {
						entries: [treeEntry, { ...treeEntry, path: "b.txt", name: "b.txt" }],
					};
				}
				if (method === "fs.readBytes") return textResponse("alpha");
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					onOpenFile={(path, _name, options) =>
						opens.push({ path, pin: options.pin, newTab: options.newTab ?? false })
					}
				/>,
			),
		);
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		expect(container.querySelector<HTMLElement>(".gui-filepane-list")?.inert).toBe(true);
		expect(container.querySelector(".gui-filepane-list")?.getAttribute("aria-hidden")).toBe("true");

		await act(async () => container.querySelector<HTMLButtonElement>(".gui-filepane-tree-toggle")?.click());
		await waitFor(() => container.querySelectorAll(".gui-filepane-row").length === 2);
		expect(container.querySelector<HTMLElement>(".gui-filepane-list")?.inert).toBe(false);
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".gui-filepane-row"));
		await act(async () => buttons.find(button => button.textContent === "a.txt")?.click());
		expect(opens).toEqual([]);

		await act(async () => buttons.find(button => button.textContent === "b.txt")?.click());
		expect(opens).toEqual([{ path: "b.txt", pin: false, newTab: true }]);
		expect(container.querySelector(".gui-filepane-preview-name")?.textContent).toBe("a.txt");
	});

	it("passes POSIX, Windows and UNC absolute paths to fs.readBytes unchanged", async () => {
		for (const path of ["/external/a.txt", "C:/external/a.txt", "//server/share/a.txt"]) {
			const reads: string[] = [];
			const rpc = {
				request: async (method: string, args?: { path?: string }) => {
					if (method === "workspace.tree") return { entries: [] };
					if (method === "fs.readBytes") {
						reads.push(args?.path ?? "");
						return textResponse("external");
					}
					return null;
				},
				addEventListener: () => () => {},
			} as unknown as RpcClient;
			const container = document.createElement("div");
			document.body.appendChild(container);
			const root = createRoot(container);
			mounted.add(root);
			await act(async () =>
				root.render(
					<FilePane
						bufferStore={filePreviewBuffers}
						rpc={rpc}
						cwd="D:/workspace"
						openRequest={{ path, nonce: 1 }}
					/>,
				),
			);
			await waitFor(() => reads.length === 1);
			expect(reads).toEqual([path]);
			await act(async () => root.unmount());
			mounted.delete(root);
			container.remove();
		}
	});

	it("requests the full viewer byte allowance for large PDFs", async () => {
		let maxBytes: number | undefined;
		const rpc = {
			request: async (method: string, args?: { maxBytes?: number }) => {
				if (method === "workspace.tree") return { entries: [] };
				if (method === "fs.readBytes") {
					maxBytes = args?.maxBytes;
					return textResponse("pdf");
				}
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(<FilePane bufferStore={filePreviewBuffers} rpc={rpc} cwd="/workspace" activeFile="large.pdf" />),
		);
		await waitFor(() => maxBytes !== undefined);
		expect(maxBytes).toBe(32 * 1024 * 1024);
	});

	it("opens an editable text file directly without a preview-to-edit switch", async () => {
		const rpc = {
			request: async (method: string) => {
				if (method === "workspace.tree") return { entries: [] };
				if (method === "fs.readBytes") return textResponse("alpha");
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(<FilePane bufferStore={filePreviewBuffers} rpc={rpc} cwd="/workspace" activeFile="a.txt" />),
		);
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		expect(container.querySelector(".gui-filepane-preview-text")).toBeNull();
		expect(container.querySelector(".gui-filepane-editor-bar")).toBeNull();
	});

	it("reveals an external line request once after the editor buffer is ready", async () => {
		const reveal = vi.spyOn(monacoLsp, "revealEditorLocation").mockImplementation(() => {});
		const rpc = {
			request: async (method: string) => {
				if (method === "workspace.tree") return { entries: [] };
				if (method === "fs.readBytes") {
					return textResponse("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve");
				}
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		const openRequest = { path: "a.txt", nonce: 1, line: 12, column: 3, pin: true };
		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					openRequest={openRequest}
				/>,
			),
		);
		await waitFor(() => reveal.mock.calls.length === 1);
		expect(reveal).toHaveBeenCalledWith({ path: "/workspace/a.txt", lineNumber: 12, column: 3 });

		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					openRequest={openRequest}
				/>,
			),
		);
		await settle();
		expect(reveal).toHaveBeenCalledTimes(1);
		reveal.mockRestore();
	});

	it("ignores a slow previous file response after the active tab changes", async () => {
		type BytesResponse = { base64: string; size: number; mime: string };
		const pending = new Map<string, PromiseWithResolvers<BytesResponse>>();
		const rpc = {
			request: (method: string, args?: { path?: string }) => {
				if (method === "workspace.tree") return Promise.resolve({ entries: [] });
				if (method === "fs.readBytes") {
					const deferred = Promise.withResolvers<BytesResponse>();
					pending.set(args?.path ?? "", deferred);
					return deferred.promise;
				}
				return Promise.resolve(null);
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		const pane = (activeFile: string) => (
			<FilePane bufferStore={filePreviewBuffers} rpc={rpc} cwd="/workspace" activeFile={activeFile} />
		);
		await act(async () => root.render(pane("a.txt")));
		await waitFor(() => pending.has("/workspace/a.txt"));
		await act(async () => root.render(pane("b.txt")));
		await waitFor(() => pending.has("/workspace/b.txt"));

		await act(async () => pending.get("/workspace/b.txt")?.resolve(textResponse("new file")));
		await waitFor(() => container.querySelector(".gui-filepane-preview-name")?.textContent === "b.txt");
		await act(async () => pending.get("/workspace/a.txt")?.resolve(textResponse("old file")));
		await settle();
		expect(container.querySelector(".gui-filepane-preview-name")?.textContent).toBe("b.txt");
		expect(container.querySelector(".gui-filepane-preview-body")?.getAttribute("data-file-path")).toBe(
			"/workspace/b.txt",
		);
	});

	it("opens an anchored searchable directory menu and registers its file as a new tab", async () => {
		const opens: Array<{ path: string; pin: boolean; newTab: boolean }> = [];
		const rpc = {
			request: async (method: string, args?: { root?: string }) => {
				if (method === "workspace.tree") {
					return {
						entries: args?.root === "docs" ? [{ ...treeEntry, path: "docs/b.txt", name: "b.txt", depth: 2 }] : [],
					};
				}
				if (method === "fs.readBytes") return textResponse("alpha");
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="docs/a.txt"
					onOpenFile={(path, _name, options) =>
						opens.push({ path, pin: options.pin, newTab: options.newTab ?? false })
					}
				/>,
			),
		);
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.gui-filepane-path-part[title="docs"]')?.click(),
		);
		await waitFor(() => document.querySelector(".gui-filepane-directory-entry")?.textContent === "b.txt");
		expect(document.querySelector(".gui-dialog-backdrop")).toBeNull();
		expect(document.querySelector(".gui-filepane-directory-menu input[type='search']")).not.toBeNull();
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-filepane-directory-entry")?.click());
		// Opening a file dismisses the menu; its exit animation unmounts it
		// CLOSE_MS later, which must land inside act before the test ends.
		await waitFor(() => document.querySelector(".gui-filepane-directory-menu") === null);
		expect(opens).toEqual([{ path: "docs/b.txt", pin: false, newTab: true }]);
	});

	it("routes the content close button to the real panel tab close callback", async () => {
		let closes = 0;
		const rpc = {
			request: async (method: string) => {
				if (method === "workspace.tree") return { entries: [] };
				if (method === "fs.readBytes") return textResponse("alpha");
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					onClosePreview={() => {
						closes += 1;
					}}
				/>,
			),
		);
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		await act(async () =>
			container.querySelector<HTMLButtonElement>(".gui-filepane-preview-head > button:last-child")?.click(),
		);
		expect(closes).toBe(1);
	});

	it("wires file-header history buttons to navigation and boundary states", async () => {
		const calls: string[] = [];
		const rpc = {
			request: async (method: string) => {
				if (method === "workspace.tree") return { entries: [] };
				if (method === "fs.readBytes") return textResponse("alpha");
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					canNavigateBack
					canNavigateForward
					onNavigateBack={() => calls.push("back")}
					onNavigateForward={() => calls.push("forward")}
				/>,
			),
		);
		await waitFor(() => container.querySelector(".gui-filepane-editor") !== null);
		const back = container.querySelector<HTMLButtonElement>(".gui-filepane-history-back");
		const forward = container.querySelector<HTMLButtonElement>(".gui-filepane-history-forward");
		expect(back?.disabled).toBe(false);
		expect(forward?.disabled).toBe(false);
		await act(async () => back?.click());
		await act(async () => forward?.click());
		expect(calls).toEqual(["back", "forward"]);

		await act(async () =>
			root.render(
				<FilePane
					bufferStore={filePreviewBuffers}
					rpc={rpc}
					cwd="/workspace"
					activeFile="a.txt"
					canNavigateBack={false}
				/>,
			),
		);
		expect(container.querySelector<HTMLButtonElement>(".gui-filepane-history-back")?.disabled).toBe(true);
		expect(container.querySelector<HTMLButtonElement>(".gui-filepane-history-forward")?.disabled).toBe(true);
	});

	it("converts Windows preview paths to the relative paths required by fs.write", () => {
		expect(filePreviewWorkspacePath("D:/workspace", "d:\\workspace\\src\\a.ts")).toBe("src/a.ts");
		expect(filePreviewWorkspacePath("\\\\server\\share\\work", "//SERVER/share/work/src/a.ts")).toBe("src/a.ts");
		expect(filePreviewWorkspacePath("/workspace", "/workspace/src/a.ts")).toBe("src/a.ts");
		expect(filePreviewWorkspacePath("D:/workspace", "D:/elsewhere/a.ts")).toBe("D:/elsewhere/a.ts");
	});

	it("matches quote targets across absolute, relative, and Windows path spellings", () => {
		expect(filePreviewPathEquals("D:/workspace", "d:\\workspace\\docs\\a.pdf", "docs/a.pdf")).toBe(true);
		expect(filePreviewPathEquals("D:/workspace", "D:/workspace/docs/a.pdf", "docs/b.pdf")).toBe(false);
		expect(filePreviewPathEquals("/workspace", "/workspace/docs/a.pdf", "docs/a.pdf")).toBe(true);
	});

	it("retains a deactivation buffer but not an accepted dirty close", () => {
		const buffer = { text: "dirty draft", saved: "disk text" };
		stashFilePreviewBuffer("/workspace/deactivated.txt", buffer);
		expect(restoreFilePreviewBuffer("/workspace/deactivated.txt")).toEqual(buffer);

		discardFilePreviewBuffer("/workspace", "closed.txt");
		stashFilePreviewBuffer("/workspace/closed.txt", buffer);
		expect(restoreFilePreviewBuffer("/workspace/closed.txt")).toBeNull();
	});

	it("restores one dirty buffer across Windows path spelling differences", () => {
		const buffer = { text: "renamed draft", saved: "disk text" };
		stashFilePreviewBuffer("D:\\workspace\\src\\a.ts", buffer);
		expect(restoreFilePreviewBuffer("d:/workspace/src/a.ts")).toEqual(buffer);

		discardFilePreviewBuffer("D:/workspace", "src/a.ts");
		stashFilePreviewBuffer("d:\\workspace\\src\\a.ts", buffer);
		expect(restoreFilePreviewBuffer("D:/workspace/src/a.ts")).toBeNull();
	});
});
