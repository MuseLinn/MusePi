import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectDialog } from "../src/components/ProjectDialog";

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return { container, root };
}

function workspace(root: string, name: string, additionalDirs: string[]) {
	return {
		id: `id-${root}`,
		root,
		name,
		kind: "managed" as const,
		additionalDirs,
		createdAt: 0,
		lastOpenedAt: 0,
	};
}

describe("ProjectDialog", () => {
	it("creates a project with the picked source folder", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const created = workspace("/work/new", "new", ["/work/shared"]);
		const rpc = {
			async request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				if (method === "workspace.create") return { workspace: created, duplicates: [] } as T;
				throw new Error(`unexpected RPC: ${method}`);
			},
		};
		let pick = 0;
		const picked = ["/work/new", "/work/shared"];
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			openDirectory: async () => picked[pick++] ?? null,
		};
		let saved: unknown = null;
		await mount(
			<ProjectDialog
				open
				mode="create"
				target={{ root: "", name: "", additionalDirs: [] }}
				rpc={rpc as never}
				onClose={() => {}}
				onSaved={result => {
					saved = result;
				}}
			/>,
		);

		// The create flow opens the dialog first; the primary folder is picked
		// inside it and fills the empty name.
		const primary = document.querySelector<HTMLButtonElement>(".gui-new-project-path");
		expect(primary).not.toBeNull();
		await act(async () => primary?.click());
		await flush();
		const nameInput = document.querySelector<HTMLInputElement>(".gui-project-dialog input.gui-input");
		expect(nameInput?.value).toBe("new");

		const add = document.querySelector<HTMLButtonElement>(".gui-directory-editor-footer button");
		expect(add).not.toBeNull();
		await act(async () => add?.click());
		await flush();
		expect(document.body.textContent).toContain("/work/shared");

		const save = document.querySelector<HTMLButtonElement>(".gui-project-dialog .gui-btn-primary");
		expect(save?.disabled).toBe(false);
		await act(async () => save?.click());
		await flush();

		expect(calls).toContainEqual({
			method: "workspace.create",
			params: { root: "/work/new", name: "new", additionalDirs: ["/work/shared"] },
		});
		expect(saved).not.toBeNull();
	});

	it("stages a primary swap and saves it before the directory update", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const rpc = {
			async request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				if (method === "fs.stat") return { exists: true, isDirectory: true } as T;
				if (method === "workspace.setPrimary") {
					return { workspace: workspace("/work/shared", "alpha", ["/work/alpha"]) } as T;
				}
				if (method === "workspace.update") {
					return { workspace: workspace("/work/shared", "alpha", ["/work/alpha"]), duplicates: [] } as T;
				}
				throw new Error(`unexpected RPC: ${method}`);
			},
		};
		const { container } = await mount(
			<ProjectDialog
				open
				mode="edit"
				target={{
					id: "id-alpha",
					root: "/work/alpha",
					name: "alpha",
					additionalDirs: ["/work/shared"],
				}}
				rpc={rpc as never}
				onClose={() => {}}
				onSaved={() => {}}
			/>,
		);

		const promote = document.querySelector<HTMLButtonElement>(".gui-directory-row-actions button");
		expect(promote).not.toBeNull();
		await act(async () => promote?.click());
		await flush(2);

		const save = document.querySelector<HTMLButtonElement>(".gui-project-dialog .gui-btn-primary");
		expect(save?.disabled).toBe(false);
		await act(async () => save?.click());
		await flush();

		const setPrimary = calls.findIndex(call => call.method === "workspace.setPrimary");
		const update = calls.findIndex(call => call.method === "workspace.update");
		expect(setPrimary).toBeGreaterThanOrEqual(0);
		expect(update).toBeGreaterThan(setPrimary);
		expect(calls[update]?.params).toEqual({
			id: "id-alpha",
			additionalDirs: ["/work/alpha"],
		});
	});

	it("blocks saving while a directory is missing", async () => {
		const rpc = {
			async request<T>(method: string): Promise<T> {
				if (method === "fs.stat") return { exists: false, isDirectory: false } as T;
				throw new Error(`unexpected RPC: ${method}`);
			},
		};
		await mount(
			<ProjectDialog
				open
				mode="edit"
				target={{
					id: "id-alpha",
					root: "/work/alpha",
					name: "alpha",
					additionalDirs: ["/work/missing"],
				}}
				rpc={rpc as never}
				onClose={() => {}}
				onSaved={() => {}}
			/>,
		);
		await flush();

		const input = document.querySelector<HTMLInputElement>(".gui-project-dialog input.gui-input");
		expect(input).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "renamed");
			const propsKey = Object.keys(input!).find(key => key.startsWith("__reactProps$"));
			const props = input![propsKey as keyof HTMLInputElement] as unknown as {
				onChange(event: { target: HTMLInputElement }): void;
			};
			props.onChange({ target: input! });
			await Bun.sleep(0);
		});
		await flush(2);

		expect(document.querySelector(".gui-directory-row--missing")).not.toBeNull();
		const save = document.querySelector<HTMLButtonElement>(".gui-project-dialog .gui-btn-primary");
		expect(save?.disabled).toBe(true);
	});

	it("rejects a directory that is already in the list", async () => {
		const rpc = {
			async request<T>(method: string): Promise<T> {
				if (method === "fs.stat") return { exists: true, isDirectory: true } as T;
				throw new Error(`unexpected RPC: ${method}`);
			},
		};
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			openDirectory: async () => "/work/shared",
		};
		const { container } = await mount(
			<ProjectDialog
				open
				mode="edit"
				target={{
					id: "id-alpha",
					root: "/work/alpha",
					name: "alpha",
					additionalDirs: ["/work/shared"],
				}}
				rpc={rpc as never}
				onClose={() => {}}
				onSaved={() => {}}
			/>,
		);

		const add = document.querySelector<HTMLButtonElement>(".gui-directory-editor-footer button");
		await act(async () => add?.click());
		await flush();

		expect(document.querySelectorAll(".gui-directory-row")).toHaveLength(2);
		expect(document.querySelector(".gui-directory-notice")?.textContent).toContain("/work/shared");
	});
});
