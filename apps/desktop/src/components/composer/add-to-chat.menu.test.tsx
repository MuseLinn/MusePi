import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n/index.js";
import { resolveNativeFilePath, type WorkspaceEntry } from "../../lib/file-workspace";
import type { RpcClient } from "../../lib/rpc";
import { FileDirectoryMenu } from "../FileDirectoryMenu";
import {
	type AddToChatDraftApi,
	type AddToChatFile,
	registerAddToChatDraft,
	registerAddToChatFiles,
} from "./add-to-chat";

const FILE: WorkspaceEntry = {
	name: "a b[1].md",
	path: "docs/a b[1].md",
	isDir: false,
	size: 12,
	mtime: 0,
	depth: 1,
};

const FOLDER: WorkspaceEntry = {
	name: "docs",
	path: "docs",
	isDir: true,
	size: 0,
	mtime: 0,
	depth: 1,
};

function stubRpc(entries: WorkspaceEntry[]): RpcClient {
	return { request: async () => ({ entries }) } as unknown as RpcClient;
}

/** Both popups portal into `document.body`, so every query below runs on the
 *  document, not on the render host. */
interface MenuHarness {
	inserted: string[];
	staged: AddToChatFile[];
	opened: string[];
	closed(): boolean;
	rightClickRow(): void;
	menuItem(): HTMLButtonElement;
	clickItem(): Promise<void>;
	dispose(): void;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let anchorEl: HTMLButtonElement | null = null;
let harness: MenuHarness | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	anchorEl?.remove();
	document.body.innerHTML = "";
	root = null;
	host = null;
	anchorEl = null;
	harness?.dispose();
	harness = null;
});

async function mountMenu(options: {
	entries: WorkspaceEntry[];
	/** `false` registers a file intake alone: without the draft half the item
	 *  must stay disabled (a dangling intake cannot take the reference). */
	withDraft: boolean;
}): Promise<void> {
	const disposers: (() => void)[] = [];
	const inserted: string[] = [];
	const staged: AddToChatFile[] = [];
	const opened: string[] = [];
	const key = {};
	let closed = false;
	if (options.withDraft) {
		const draft: AddToChatDraftApi = {
			canInsert: () => true,
			insertMention: label => inserted.push(label),
		};
		disposers.push(registerAddToChatDraft(key, draft));
		disposers.push(
			registerAddToChatFiles(key, {
				addWorkspaceFile: async (file: AddToChatFile) => {
					staged.push(file);
					return "文件1";
				},
			}),
		);
	} else {
		disposers.push(registerAddToChatFiles({}, { addWorkspaceFile: async () => null }));
	}

	host = document.createElement("div");
	anchorEl = document.createElement("button");
	document.body.append(host, anchorEl);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<FileDirectoryMenu
				rpc={stubRpc(options.entries)}
				cwd="/work"
				path="docs"
				anchor={anchorEl}
				open
				onClose={() => {
					closed = true;
				}}
				onOpenFile={path => opened.push(path)}
			/>,
		);
		// Let workspace.tree resolve and the rows paint.
		await Promise.resolve();
		await Promise.resolve();
	});

	harness = {
		inserted,
		staged,
		opened,
		closed: () => closed,
		rightClickRow: () => {
			const row = document.querySelector<HTMLButtonElement>(".gui-filepane-directory-entry");
			if (!row) throw new Error("directory row missing");
			act(() => {
				row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 60 }));
			});
		},
		menuItem: () => {
			const item = document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
			if (!item) throw new Error("row menu did not open");
			return item;
		},
		clickItem: async () => {
			const item = harness!.menuItem();
			await act(async () => {
				item.click();
				await Promise.resolve();
			});
		},
		dispose: () => {
			for (const dispose of disposers) dispose();
		},
	};
}

function harnessRef(): MenuHarness {
	if (!harness) throw new Error("menu harness not mounted");
	return harness;
}

describe("FileDirectoryMenu add-to-chat", () => {
	test("right-click adds the file reference to the draft and opens no tab", async () => {
		await mountMenu({ entries: [FILE], withDraft: true });
		const menu = harnessRef();
		menu.rightClickRow();
		// The row gesture replaces the directory popup (one floating menu).
		expect(menu.closed()).toBe(true);
		expect(menu.menuItem().textContent).toContain(t("settings.addToChat"));
		await menu.clickItem();
		expect(menu.staged).toEqual([
			{ path: resolveNativeFilePath("/work", FILE.path), name: FILE.name, size: FILE.size },
		]);
		expect(menu.inserted).toEqual(["文件1"]);
		expect(menu.opened).toEqual([]);
	});

	test("without a live draft the item is disabled and explains why", async () => {
		await mountMenu({ entries: [FILE], withDraft: false });
		const menu = harnessRef();
		menu.rightClickRow();
		const item = menu.menuItem();
		expect(item.disabled).toBe(true);
		expect(item.textContent).toContain(t("settings.addToChatUnavailable"));
		await menu.clickItem();
		expect(menu.staged).toEqual([]);
	});

	test("a folder row carries the same item disabled with the folder reason", async () => {
		await mountMenu({ entries: [FOLDER], withDraft: true });
		const menu = harnessRef();
		menu.rightClickRow();
		const item = menu.menuItem();
		expect(item.disabled).toBe(true);
		expect(item.textContent).toContain(t("settings.addToChatFolder"));
		await menu.clickItem();
		expect(menu.staged).toEqual([]);
	});
});
