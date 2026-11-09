import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionListNode } from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";
import { dismissActionToast, getToasts } from "../src/lib/action-toast";
import { PromptProvider } from "../src/lib/prompt-dialog";
import { LEGACY_MIGRATION_KEY, LEGACY_PROJECTS_KEY } from "../src/lib/workspace-projects";

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
	window.localStorage.clear();
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	for (const toast of [...getToasts()]) dismissActionToast(toast.id);
});

function node(id: string, label: string, cwd: string): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children: [] };
}

interface ProjectRow {
	id: string;
	root: string;
	name: string;
	kind: "managed" | "implicit";
	additionalDirs: string[];
	createdAt: number;
	lastOpenedAt: number;
}

function project(root: string, name: string, kind: ProjectRow["kind"] = "managed"): ProjectRow {
	return { id: `id-${root}`, root, name, kind, additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
}

function sidebar(
	options: { nodes: SessionListNode[]; sessionMeta: Map<string, { cwd?: string }> },
	rpc: { request<T = unknown>(method: string, params?: unknown): Promise<T> },
	extra: { onNewSessionInProject?(cwd: string): void } = {},
): React.ReactNode {
	return (
		<SessionSidebar
			nodes={options.nodes}
			sessionMeta={options.sessionMeta}
			selectedId={null}
			rpc={rpc as never}
			onSelect={() => {}}
			onNewSession={() => {}}
			onNewSessionInProject={extra.onNewSessionInProject}
			onDisconnect={() => {}}
			onOpenConnect={() => {}}
			onOpenSettings={() => {}}
			onOpenSearch={() => {}}
			collapsed={false}
			onDeleteArchived={async () => true}
			connected
			daemonUrl="ws://localhost:8300"
			onReconnect={() => {}}
			hosts={[]}
			onSwitchHost={() => {}}
			onAddHost={() => {}}
			onRemoveHost={() => {}}
		/>
	);
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

/** Type into the prompt dialog through React's own change handler (a plain
 *  value assignment never reaches the controlled input's state). */
async function typePrompt(value: string): Promise<void> {
	const input = document.querySelector<HTMLInputElement>(".gui-dialog input");
	if (!input) throw new Error("prompt input did not render");
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
		const props = input[propsKey as keyof HTMLInputElement] as unknown as {
			onChange(event: { target: HTMLInputElement }): void;
		};
		props.onChange({ target: input });
		await Bun.sleep(0);
	});
}

/** Confirm the open prompt/confirm dialog and wait out its exit animation. */
async function confirmDialog(): Promise<void> {
	const button = document.querySelector<HTMLButtonElement>(".gui-dialog .gui-btn-primary");
	await act(async () => button?.click());
	await flush(25);
}

describe("session sidebar project registry", () => {
	it("lists projects from workspace.list even with no legacy project storage", async () => {
		window.localStorage.setItem("musepi-gui-sidebar-tab", "projects");
		const calls: string[] = [];
		const rows = [
			project("/work/alpha", "alpha"),
			project("/work/beta", "beta", "implicit"),
			// Remote-session mirrors stay out of the local workspace list.
			project("/Users/me/.musepi/remote/host-a", "host-a", "implicit"),
		];
		const rpc = {
			async request<T>(method: string, params?: unknown): Promise<T> {
				calls.push(method);
				switch (method) {
					case "workspace.list":
						return { workspaces: rows } as T;
					case "fs.stat":
						return { exists: true, isDirectory: true } as T;
					case "session.directories.list":
						return { directories: [] } as T;
					default:
						throw new Error(`unexpected RPC: ${method}`);
				}
			},
		};
		const { container } = await mount(
			sidebar(
				{
					nodes: [node("s1", "Session one", "/work/alpha")],
					sessionMeta: new Map([["s1", { cwd: "/work/alpha" }]]),
				},
				rpc,
			),
		);

		expect(calls).toContain("workspace.list");
		expect(container.textContent).toContain("alpha");
		expect(container.textContent).toContain("beta");
		expect(container.textContent).toContain("Session one");
		// A remote mount is an implicit row too, but it belongs to 远程连接.
		expect(container.textContent).not.toContain("host-a");

		// The legacy key is a derived mirror for surfaces not yet on the
		// registry; the tab itself reads the daemon rows.
		expect(window.localStorage.getItem(LEGACY_MIGRATION_KEY)).toBe("1");
		expect(JSON.parse(window.localStorage.getItem(LEGACY_PROJECTS_KEY) ?? "[]")).toEqual([
			"/work/alpha",
			"/work/beta",
		]);
	});

	it("re-reads the registry when a session brings a new workspace directory", async () => {
		window.localStorage.setItem("musepi-gui-sidebar-tab", "projects");
		let rows = [project("/work/alpha", "alpha")];
		const rpc = {
			async request<T>(method: string): Promise<T> {
				switch (method) {
					case "workspace.list":
						return { workspaces: rows } as T;
					case "fs.stat":
						return { exists: true, isDirectory: true } as T;
					default:
						throw new Error(`unexpected RPC: ${method}`);
				}
			},
		};
		const first = await mount(
			sidebar(
				{
					nodes: [node("s1", "Session one", "/work/alpha")],
					sessionMeta: new Map([["s1", { cwd: "/work/alpha" }]]),
				},
				rpc,
			),
		);
		expect(first.container.textContent).not.toContain("gamma");

		rows = [...rows, project("/work/gamma", "gamma", "implicit")];
		await act(async () =>
			first.root.render(
				sidebar(
					{
						nodes: [node("s1", "Session one", "/work/alpha"), node("s2", "Session two", "/work/gamma")],
						sessionMeta: new Map([
							["s1", { cwd: "/work/alpha" }],
							["s2", { cwd: "/work/gamma" }],
						]),
					},
					rpc,
				),
			),
		);
		await flush();
		expect(first.container.textContent).toContain("gamma");
	});

	it("reports a duplicate directory from the session working-directory menu", async () => {
		// The menu now uses the native picker; happy-dom has no Electron shell.
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			openDirectory: async () => "/work/shared",
		};
		const calls: Array<{ method: string; params: unknown }> = [];
		const rpc = {
			async request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				switch (method) {
					case "workspace.list":
						return { workspaces: [project("/work/alpha", "alpha")] } as T;
					case "session.directories.list":
						return { directories: [{ path: "/work/alpha", primary: true, exists: true }] } as T;
					case "session.directories.add":
						return {
							added: false,
							directory: null,
							duplicate: { path: "/work/shared", directory: "/work/shared" },
							directories: [{ path: "/work/alpha", primary: true, exists: true }],
						} as T;
					default:
						throw new Error(`unexpected RPC: ${method}`);
				}
			},
		};
		const { container } = await mount(
			<PromptProvider>
				{sidebar(
					{
						nodes: [node("s1", "Session one", "/work/alpha")],
						sessionMeta: new Map([["s1", { cwd: "/work/alpha" }]]),
					},
					rpc,
				)}
			</PromptProvider>,
		);
		const row = container.querySelector<HTMLElement>(".gui-session-row");
		expect(row).not.toBeNull();
		await act(async () => {
			row?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }),
			);
		});
		await flush();
		const addItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
			item.textContent?.includes(t("settings.addWorkingDirectory")),
		);
		expect(addItem).toBeDefined();
		await act(async () => addItem?.click());
		await flush(6);

		expect(calls).toContainEqual({
			method: "session.directories.add",
			params: { sessionId: "s1", directory: "/work/shared" },
		});
		// The daemon's duplicate structure — not a generic failure — drives the
		// hint, so the user learns which directory is already there.
		expect(getToasts().some(toast => toast.kind === "error" && toast.message.includes("/work/shared"))).toBe(true);
	});

	it("edits and deletes a managed project through workspace RPC", async () => {
		window.localStorage.setItem("musepi-gui-sidebar-tab", "projects");
		const calls: Array<{ method: string; params: unknown }> = [];
		const rpc = {
			async request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				switch (method) {
					case "workspace.list":
						return { workspaces: [project("/work/alpha", "alpha")] } as T;
					case "fs.stat":
						return { exists: true, isDirectory: true } as T;
					case "workspace.update":
						return { workspace: project("/work/alpha", "alpha-renamed"), duplicates: [] } as T;
					case "workspace.delete":
						return { deleted: true } as T;
					default:
						throw new Error(`unexpected RPC: ${method}`);
				}
			},
		};
		const { container } = await mount(
			<PromptProvider>
				{sidebar(
					{
						nodes: [node("s1", "Session one", "/work/alpha")],
						sessionMeta: new Map([["s1", { cwd: "/work/alpha" }]]),
					},
					rpc,
				)}
			</PromptProvider>,
		);
		const openProjectMenu = async (): Promise<void> => {
			const head = container.querySelector<HTMLElement>(".gui-project-head");
			expect(head).not.toBeNull();
			await act(async () => {
				head?.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
				);
			});
			await flush();
		};

		await openProjectMenu();
		const editItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
			item.textContent?.includes(t("projectDialog.editTitle")),
		);
		expect(editItem).toBeDefined();
		await act(async () => editItem?.click());
		await flush(3);
		await typePrompt("alpha-renamed");
		await confirmDialog();
		expect(calls).toContainEqual({
			method: "workspace.update",
			params: { id: "id-/work/alpha", name: "alpha-renamed", additionalDirs: [] },
		});

		await openProjectMenu();
		const removeItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
			item.textContent?.includes(t("general.removeProject")),
		);
		expect(removeItem).toBeDefined();
		await act(async () => removeItem?.click());
		await flush(3);
		await confirmDialog();
		expect(calls).toContainEqual({ method: "workspace.delete", params: { id: "id-/work/alpha" } });
	});

	it("hover actions create a session in that project and open the folder with the OS label", async () => {
		window.localStorage.setItem("musepi-gui-sidebar-tab", "projects");
		const revealed: string[] = [];
		const created: string[] = [];
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			platform: "win32",
			openPath: async (path: string) => {
				revealed.push(path);
				return { ok: true };
			},
		};
		const rpc = {
			async request<T>(method: string): Promise<T> {
				switch (method) {
					case "workspace.list":
						return { workspaces: [project("/work/alpha", "alpha")] } as T;
					case "fs.stat":
						return { exists: true, isDirectory: true } as T;
					case "session.directories.list":
						return { directories: [] } as T;
					default:
						throw new Error(`unexpected RPC: ${method}`);
				}
			},
		};
		const { container } = await mount(
			sidebar(
				{
					nodes: [node("s1", "Session one", "/work/alpha")],
					sessionMeta: new Map([["s1", { cwd: "/work/alpha" }]]),
				},
				rpc,
				{ onNewSessionInProject: cwd => created.push(cwd) },
			),
		);

		const actions = [...container.querySelectorAll<HTMLButtonElement>(".gui-project-action")];
		expect(actions).toHaveLength(3);
		await act(async () => actions[2]!.click());
		expect(created).toEqual(["/work/alpha"]);

		await act(async () => actions[1]!.click());
		await flush();
		const revealItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
			item.textContent?.includes(t("settings.openInExplorer")),
		);
		expect(revealItem).toBeDefined();
		await act(async () => revealItem?.click());
		await flush();
		expect(revealed).toEqual(["/work/alpha"]);
	});
});
