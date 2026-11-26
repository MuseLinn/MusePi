import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemotePathPicker } from "../src/components/RemotePathPicker";
import type { RpcClient } from "../src/lib/rpc";

/**
 * The picker that asks the daemon's own filesystem.
 *
 * `workspace.create` resolves the project root on the daemon, so a project
 * added while connected to a remote host must be chosen from that host's tree.
 * The OS dialog on this machine returns a path the daemon never had — the
 * failure this dialog exists to prevent.
 */

setLocale("zh-CN");
afterAll(() => setLocale("en-US"));

const mounted: Root[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) act(() => root.unmount());
	document.body.innerHTML = "";
});

function rpcStub(tree: Record<string, { name: string; path: string; isDir: boolean }[]>): RpcClient {
	return {
		request: async (method: string, params?: unknown) => {
			if (method !== "fs.list") throw new Error(`unexpected ${method}`);
			const path = (params as { path?: string } | undefined)?.path ?? "/home/me";
			return { path, parent: path === "/home/me" ? "/home" : null, entries: tree[path] ?? [] };
		},
	} as unknown as RpcClient;
}

async function render(overrides: { onPick?: (path: string) => void } = {}) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(root);
	const picked: string[] = [];
	await act(async () => {
		root.render(
			createElement(RemotePathPicker, {
				open: true,
				rpc: rpcStub({
					"/home/me": [
						{ name: "code", path: "/home/me/code", isDir: true },
						{ name: "notes.txt", path: "/home/me/notes.txt", isDir: false },
					],
					"/home/me/code": [],
				}),
				hostLabel: "rog",
				onClose: () => {},
				onPick: path => {
					picked.push(path);
					overrides.onPick?.(path);
				},
			}),
		);
		await Bun.sleep(20);
	});
	return { host, picked };
}

const rows = (): HTMLElement[] => Array.from(document.body.querySelectorAll<HTMLElement>(".gui-path-picker-row"));

describe("remote path picker", () => {
	test("it lists folders from the daemon, and says which machine that is", async () => {
		await render();
		// The header is the point: this is not this machine's filesystem.
		expect(document.body.textContent).toContain(t("projectDialog.pickingOnHost", { host: "rog" }));
		// Folders only — a project root is a directory, so a file row would be a
		// target the daemon rejects.
		expect(rows().map(row => row.textContent)).toEqual(["code"]);
	});

	test("descending into a folder and confirming hands its path back", async () => {
		const { picked } = await render();
		await act(async () => {
			rows()[0]?.click();
			await Bun.sleep(20);
		});
		const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("projectDialog.useThisFolder")),
		);
		await act(async () => {
			confirm?.click();
			await Bun.sleep(10);
		});
		expect(picked).toEqual(["/home/me/code"]);
	});

	test("an unreadable directory reports the reason instead of an empty list", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.push(root);
		await act(async () => {
			root.render(
				createElement(RemotePathPicker, {
					open: true,
					rpc: {
						request: async () => ({
							path: "/root",
							parent: null,
							entries: [],
							error: "EACCES: permission denied",
						}),
					} as unknown as RpcClient,
					onClose: () => {},
					onPick: () => {},
				}),
			);
			await Bun.sleep(20);
		});
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("EACCES");
	});
});
