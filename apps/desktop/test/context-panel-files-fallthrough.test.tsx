import "./happy-dom-shim"; // MUST be first: component modules define DOM classes at evaluation time.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import type { PanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import { type GuiSessionState, GuiSessionStore } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// Surface bodies must never fall through to another surface: a files tab whose
// workspace is missing used to render the context readings (label said 文件,
// content said 上下文). Each surface now answers for itself — the files tab with
// its own empty state, the context tab with the context readouts.

setLocale("en-US");

const globals = globalThis as typeof globalThis & {
	__filesWorkspaceMount?: { cwd?: string; sessionId?: string | null };
};

const rpc = {
	request: async () => null,
	addEventListener: () => () => {},
} as unknown as RpcClient;

function filesTab(): PanelTab {
	return {
		id: "files::",
		surface: "files",
		target: null,
		label: "Files",
		readOnly: false,
		touchedAt: 1,
		dedupeKey: null,
		dirty: false,
		preview: false,
		column: 0,
	};
}

function contextTab(): PanelTab {
	return {
		id: "context::",
		surface: "context",
		target: null,
		label: "Context",
		readOnly: false,
		touchedAt: 1,
		dedupeKey: null,
		dirty: false,
		preview: false,
		column: 0,
	};
}

function unknownTab(): PanelTab {
	return {
		id: "retired-surface::",
		surface: "retired-surface",
		target: null,
		label: "Retired",
		readOnly: false,
		touchedAt: 1,
		dedupeKey: null,
		dirty: false,
		preview: false,
		column: 0,
	};
}

function panelTabsFor(tab: PanelTab): UsePanelTabsResult {
	return {
		tabs: [tab],
		activeId: tab.id,
		split: false,
		columnActive: [tab.id, null],
		open: () => {},
		close: () => {},
		closeMany: () => {},
		duplicate: () => {},
		activate: () => {},
		reorder: () => {},
		moveToColumn: () => {},
		setSplit: () => {},
		setDirty: () => {},
	};
}

function snapshot(cwd: string | null, sessionId: string | null = "s1"): GuiSessionState {
	return {
		sessionId,
		entries: [],
		state: cwd === null ? null : ({ cwd } as unknown as GuiSessionState["state"]),
		streaming: false,
		activeTools: new Map(),
		working: false,
		cursor: 0,
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		unviewedCompleted: [],
		approvals: [],
		recap: null,
		roundDurations: new Map(),
	} as unknown as GuiSessionState;
}

/** The real file workspace is a compiled slot module; this stand-in reports
 *  the props the mount received so the test can see which surface rendered. */
const filesExtTab = {
	slot: "panel.tab.files",
	extensionId: "test-file-workspace",
	code: `export default function Page(props) {
		globalThis.__filesWorkspaceMount = { cwd: props.cwd, sessionId: props.sessionId };
		return null;
	}`,
};

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

async function renderPanel(
	tab: PanelTab,
	options?: { cwd?: string | null; cwdOverride?: string; extTabs?: readonly (typeof filesExtTab)[] },
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<ContextPanel
				snap={snapshot(options?.cwd === undefined ? "C:/workspace" : options.cwd)}
				rpc={rpc}
				cwd={options?.cwdOverride}
				onViewChange={() => {}}
				panelTabs={panelTabsFor(tab)}
				agentId={null}
				onAgentSelect={() => {}}
				extTabs={options?.extTabs}
			/>,
		);
	});
	// Slot modules load through a dynamic import; one microtask turn is not
	// enough for the mount to publish its props.
	await act(async () => {
		await Bun.sleep(20);
	});
	return host;
}

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	delete globals.__filesWorkspaceMount;
});

describe("ContextPanel surface body fallthrough", () => {
	it("files tab without a workspace renders the files empty state, not the context readouts", async () => {
		const host = await renderPanel(filesTab(), { cwd: "" });
		expect(host.textContent).toContain(t("settings.noWorkspace"));
		expect(host.textContent).not.toContain(t("general.stats"));
		expect(host.textContent).not.toContain(t("sessionInfo.tokens"));
	});

	it("files tab with a workspace mounts the file workspace with that cwd", async () => {
		const host = await renderPanel(filesTab(), { cwd: "C:/workspace", extTabs: [filesExtTab] });
		expect(globals.__filesWorkspaceMount).toEqual({ cwd: "C:/workspace", sessionId: "s1" });
		expect(host.textContent).not.toContain(t("settings.noWorkspace"));
		expect(host.textContent).not.toContain(t("general.stats"));
	});

	it("files tab falls back to the host's cwd when the session state carries none", async () => {
		await renderPanel(filesTab(), { cwd: "", cwdOverride: "D:/project", extTabs: [filesExtTab] });
		expect(globals.__filesWorkspaceMount).toEqual({ cwd: "D:/project", sessionId: "s1" });
	});

	it("context tab still renders the context readouts", async () => {
		const host = await renderPanel(contextTab(), { cwd: "C:/workspace" });
		expect(host.textContent).toContain(t("general.stats"));
		expect(host.textContent).toContain(t("general.messages"));
	});

	it("an unknown surface renders an explicit empty state instead of the context readouts", async () => {
		const host = await renderPanel(unknownTab(), { cwd: "C:/workspace" });
		expect(host.textContent).toContain(t("tools.bundlePluginDisabled"));
		expect(host.textContent).not.toContain(t("general.stats"));
	});
});

describe("GuiSessionStore workspace fallback", () => {
	it("takes the snapshot's workspace when the host passed none", () => {
		const store = new GuiSessionStore(
			"store-cwd-fallback",
			{
				entries: [],
				state: { cwd: "D:/from-state", isStreaming: false, queuedMessageCount: 0, participants: [] },
				cursor: 0,
			} as never,
			"",
		);
		expect(store.cwd).toBe("D:/from-state");
		expect(store.getSnapshot().state?.cwd).toBe("D:/from-state");
	});
});
