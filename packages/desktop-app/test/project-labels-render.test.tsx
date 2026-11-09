import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t, writeArchivedSessions } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledTasksPanel } from "../src/components/ScheduledTasksPanel";
import type { SessionListNode } from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";
import { MemorySection } from "../src/components/settings-sections/memory";
import { clearTaskNav, publishTaskNav } from "../src/lib/scheduled-task-nav";

/**
 * Workspace rows name the FOLDER; the full cwd stays on the row's title.
 * Regression target: both surfaces sliced the cwd with `split("/")`, so a
 * Windows path (`D:\work\a\demo`) rendered its full path as the name, and two
 * workspaces sharing a basename were indistinguishable.
 */

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
	writeArchivedSessions([]);
	clearTaskNav();
});

async function mount(ui: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return container;
}

function node(id: string, label: string): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children: [] };
}

describe("archived session rows", () => {
	it("shows the folder name and keeps the full path on the title", async () => {
		writeArchivedSessions([
			{ sessionId: "s1", archivedAt: 1, cwd: "D:\\work\\alpha\\demo" },
			{ sessionId: "s2", archivedAt: 2, cwd: "D:\\work\\beta\\demo" },
			{ sessionId: "s3", archivedAt: 3, cwd: "D:\\work\\alpha\\solo" },
		]);
		const rpc = { request: async <T,>(): Promise<T> => ({}) as T };
		const container = await mount(
			<SessionSidebar
				nodes={[node("s1", "One"), node("s2", "Two"), node("s3", "Three")]}
				sessionMeta={new Map()}
				selectedId={null}
				rpc={rpc as never}
				onSelect={() => {}}
				onNewSession={() => {}}
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
			/>,
		);

		const archiveToggle = container.querySelector<HTMLButtonElement>(`[aria-label="${t("settings.archive")}"]`);
		expect(archiveToggle).not.toBeNull();
		await act(async () => archiveToggle?.click());
		await flush();

		const folders = [...container.querySelectorAll<HTMLElement>(".gui-archive-row span[title]")];
		expect(folders.map(span => span.textContent)).toEqual(["alpha/demo", "beta/demo", "solo"]);
		// Identity — the full cwd — is still reachable without widening the label.
		expect(folders.map(span => span.getAttribute("title"))).toEqual([
			"D:\\work\\alpha\\demo",
			"D:\\work\\beta\\demo",
			"D:\\work\\alpha\\solo",
		]);
	});
});

describe("scheduled task left panel", () => {
	it("groups Windows workspaces by folder name with the path on the header title", async () => {
		// The list now lives in the rail's sidebar slot, fed by the page's
		// cron.list projection through the task-nav bridge — not a column
		// inside ScheduledTasksPage.
		clearTaskNav();
		publishTaskNav({
			tasks: [
				{ id: "a", name: "Alpha", enabled: true, cwd: "D:\\work\\alpha\\demo" },
				{ id: "b", name: "Beta", enabled: true, cwd: "D:\\work\\beta\\demo" },
				{ id: "c", name: "Gamma", enabled: true, cwd: "D:\\work\\alpha\\solo" },
			],
			selectedId: null,
			view: "tasks",
			busy: false,
		});
		const container = await mount(<ScheduledTasksPanel width={256} collapsed={false} />);

		const heads = [...container.querySelectorAll<HTMLElement>(".gui-side-panel-section-title > span[title]")];
		// Group order follows the cwd sort (alpha/demo, alpha/solo, beta/demo).
		expect(heads.map(head => head.textContent)).toEqual(["alpha/demo", "solo", "beta/demo"]);
		expect(heads.map(head => head.getAttribute("title"))).toEqual([
			"D:\\work\\alpha\\demo",
			"D:\\work\\alpha\\solo",
			"D:\\work\\beta\\demo",
		]);
	});
});

describe("memory workspace selector", () => {
	it("names each workspace by its encoded directory, not the raw key", async () => {
		const rpc = {
			request: async <T,>(method: string): Promise<T> => {
				// WorkspaceMemory only renders for the local summary backend.
				if (method === "memory.status") return { status: { backend: "local" } } as T;
				if (method === "memory.workspace") {
					return {
						root: "/mem/D-Projects-demo",
						slug: "--D-Projects-demo--",
						// Both keys encode a workspace named `demo`; the label must
						// stay distinguishable instead of repeating "demo".
						workspaces: ["--D-work-a-demo--", "--D-work-b-demo--"],
						files: [],
					} as T;
				}
				return {} as T;
			},
		};
		const container = await mount(<MemorySection rpc={rpc as never} />);

		const options = [...container.querySelectorAll<HTMLOptionElement>("select option")];
		// The selected-but-unlisted current workspace is prepended, and all three
		// `demo` folders widen to their parent so the row stays distinguishable.
		expect(options.map(option => option.textContent)).toEqual(["Projects/demo", "a/demo", "b/demo"]);
		// Identity stays the on-disk key.
		expect(options.map(option => option.value)).toEqual([
			"--D-Projects-demo--",
			"--D-work-a-demo--",
			"--D-work-b-demo--",
		]);
	});
});
