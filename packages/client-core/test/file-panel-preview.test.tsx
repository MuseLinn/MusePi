import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilePanel } from "../src/components/panels/FilePanel";
import { t } from "../src/i18n/index";
import type { SessionClient } from "../src/lib/client";
import { MAX_FILE_PREVIEW_BYTES } from "../src/lib/file-preview";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FILES: WorkspaceEntry[] = [
	{ name: "shot.png", path: "shots/shot.png", isDir: false, size: 9, mtime: 1, depth: 0 },
	{ name: "notes.md", path: "notes.md", isDir: false, size: 5, mtime: 1, depth: 0 },
];

interface Call {
	method: string;
	params?: unknown;
}

/** Minimal SessionClient: the panel only needs `rpc`. */
function fakeClient(readBytes: unknown): { client: SessionClient; calls: Call[] } {
	const calls: Call[] = [];
	async function rpc<T>(method: string, params?: unknown): Promise<T> {
		calls.push({ method, params });
		if (method === "workspace.tree") {
			return { rootPath: "/work", truncated: false, entries: FILES } as T;
		}
		return readBytes as T;
	}
	return { client: { rpc } as unknown as SessionClient, calls };
}

let root: Root | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

async function mount(client: SessionClient, readOnly = true): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<FilePanel client={client} cwd="/work" readOnly={readOnly} />);
	});
	await act(async () => {});
	return host;
}

function fileButton(host: HTMLElement, name: string): HTMLButtonElement {
	const button = [...host.querySelectorAll("button")].find(node => node.textContent === name);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`no file row named ${name}`);
	return button;
}

describe("FilePanel preview (one read contract on every transport)", () => {
	it("reads through fs.readBytes with the session cwd and paints an image", async () => {
		const { client, calls } = fakeClient({
			base64: Buffer.from("png-bytes").toString("base64"),
			size: 9,
			mime: "image/png",
		});
		const host = await mount(client);
		await act(async () => fileButton(host, "shot.png").click());

		const read = calls.find(call => call.method !== "workspace.tree");
		expect(read).toEqual({
			method: "fs.readBytes",
			params: { path: "shots/shot.png", cwd: "/work", maxBytes: MAX_FILE_PREVIEW_BYTES },
		});
		// `fs.read` means UTF-8 text on the daemon and bytes on the collab host;
		// the panel must never ride on that ambiguous name.
		expect(calls.some(call => call.method === "fs.read")).toBe(false);
		expect(host.querySelector("img.sh-files-preview-image")).not.toBeNull();
	});

	it("keeps text in a preformatted body", async () => {
		const { client } = fakeClient({
			base64: Buffer.from("# hi").toString("base64"),
			size: 4,
			mime: "text/markdown",
		});
		const host = await mount(client);
		await act(async () => fileButton(host, "notes.md").click());
		expect(host.querySelector("pre.sh-files-preview-text")?.textContent).toBe("# hi");
	});

	it("shows a read refusal as an error instead of an empty frame", async () => {
		const { client } = fakeClient({ error: "file too large (9000000 bytes)" });
		const host = await mount(client);
		await act(async () => fileButton(host, "notes.md").click());
		expect(host.querySelector(".sh-panel-error")?.textContent).toContain("file too large");
	});

	it("returns from a preview to the file list with the back control", async () => {
		const { client } = fakeClient({
			base64: Buffer.from("png-bytes").toString("base64"),
			size: 9,
			mime: "image/png",
		});
		const host = await mount(client);
		await act(async () => fileButton(host, "shot.png").click());
		const body = host.querySelector(".sh-files-body");
		expect(body?.getAttribute("data-selected")).toBe("true");
		const back = host.querySelector<HTMLButtonElement>(".sh-files-back");
		if (!back) throw new Error("no back control");
		await act(async () => back.click());
		expect(host.querySelector(".sh-files-body")?.getAttribute("data-selected")).toBeNull();
		expect(fileButton(host, "notes.md")).toBeDefined();
	});

	it("creates a file with the session cwd and a relative path", async () => {
		const { client, calls } = fakeClient({ base64: "", size: 0, mime: "" });
		const host = await mount(client, false);
		const input = host.querySelector<HTMLInputElement>(".sh-files-actions input");
		if (!input) throw new Error("no new-file input");
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setValue?.call(input, "new.md");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const create = [...host.querySelectorAll("button")].find(node => node.textContent === t("guest.createFile"));
		await act(async () => create?.click());

		// The daemon requires cwd + a workspace-relative path; the collab host
		// rejects absolute paths outright, so a leading "/" here breaks both.
		expect(calls.find(call => call.method === "fs.write")).toEqual({
			method: "fs.write",
			params: { cwd: "/work", path: "new.md", content: "" },
		});
	});
});
