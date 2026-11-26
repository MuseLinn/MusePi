import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { COLLAB_PROTO, encodeBase64Url, formatCollabLink } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionEntry, SessionHeader, SessionState, WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GuestClient } from "../src/lib/client";
import { CollabSocket } from "../src/lib/socket";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { App } = await import("../src/app");
const { t } = await import("../src/i18n/index.js");

const LINK = formatCollabLink("wss://relay.example.com", "roomroomroom1234", new Uint8Array(32));
const SESSION: WorkspaceSessionInfo = {
	id: "existing-session",
	title: "Existing session",
	cwd: "/work",
	messageCount: 1,
	working: false,
	paused: false,
	live: true,
	updatedAt: 1,
};
const HEADER: SessionHeader = {
	type: "session",
	id: SESSION.id,
	timestamp: "2026-06-12T00:00:00Z",
	cwd: "/work",
};
const STATE: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] };
let root: Root | null = null;
let client: GuestClient | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	client?.close();
	client = null;
	document.body.innerHTML = "";
	localStorage.clear();
	history.replaceState(null, "", "/");
	delete window.Capacitor;
	vi.restoreAllMocks();
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

async function renderWorkspace(mobile: boolean): Promise<void> {
	window.Capacitor = { isNativePlatform: () => mobile };
	window.location.hash = LINK;
	vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
	vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) {
		client = this;
		this.applyFrameForTest({ t: "workspace", sessions: [SESSION] });
	});
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<App />);
		await Bun.sleep(0);
	});
	if (!client) throw new Error(`connection did not start: ${document.body.textContent ?? ""}`);
}

describe("mobile workspace navigation", () => {
	it("opens a draft, enters an existing session and returns without creating a session", async () => {
		await renderWorkspace(true);
		expect(document.querySelector(".sh-workspace")).toBeNull();
		expect(document.querySelector(".sh-welcome-hint")).not.toBeNull();
		expect(document.querySelector(".sh-composer")).not.toBeNull();
		expect(document.querySelector<HTMLButtonElement>(".sh-composer-send")).not.toBeNull();

		await act(async () => document.querySelector<HTMLButtonElement>(".sh-title-btn")?.click());
		await act(async () => document.querySelector<HTMLButtonElement>(".ss-item")?.click());
		expect(client?.focusedSessionId).toBe(SESSION.id);
		expect(document.querySelector(".sh-workspace")).toBeNull();
		await act(async () => {
			client?.applyFrameForTest({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: HEADER,
				state: STATE,
				agents: [] as AgentSnapshot[],
				entryCount: 1,
			});
			const entry: SessionEntry = {
				type: "message",
				id: "old-message",
				parentId: null,
				timestamp: "2026-06-12T00:00:01Z",
				message: { role: "user", content: "Old session message", timestamp: 1 },
			};
			client?.applyFrameForTest({ t: "snapshot-chunk", entries: [entry], final: true });
			await Bun.sleep(30);
		});
		expect(client?.getSnapshot().phase).toBe("live");
		expect(client?.getSnapshot().entries).toHaveLength(1);
		expect(document.body.textContent).toContain("Old session message");

		const create = vi.spyOn(client!, "rpc");
		await act(async () => {
			const back = document.querySelector<HTMLButtonElement>(".sh-header-left .sh-btn-icon");
			expect(back).not.toBeNull();
			back?.click();
			await Bun.sleep(30);
		});
		expect(client?.focusedSessionId).toBeNull();
		expect(document.querySelector(".sh-welcome-hint")).not.toBeNull();
		expect(document.body.textContent).not.toContain("Old session message");
		expect(create).not.toHaveBeenCalled();
	});

	it("opens settings from the session sheet and returns through the header", async () => {
		await renderWorkspace(true);
		await act(async () => document.querySelector<HTMLButtonElement>(".sh-title-btn")?.click());
		const actions = [...document.querySelectorAll<HTMLButtonElement>(".ss-footer-action")];
		await act(async () => actions[2]?.click());
		expect(document.querySelector(".sh-mobile-settings")).not.toBeNull();
		expect(document.querySelector(".sh-title-btn")).toBeNull();
		expect(document.querySelector(".sh-composer")).toBeNull();

		await act(async () => {
			const back = document.querySelector<HTMLButtonElement>(".sh-header-left .sh-btn-icon");
			expect(back).not.toBeNull();
			back?.click();
			await Promise.resolve();
		});
		expect(document.querySelector(".sh-mobile-settings")).toBeNull();
		expect(document.querySelector(".sh-composer")).not.toBeNull();
	});

	it("keeps the desktop web workspace directory unchanged", async () => {
		await renderWorkspace(false);
		expect(document.querySelector(".sh-workspace")).not.toBeNull();
		expect(document.querySelector(".sh-composer-input")).toBeNull();
	});

	it("does not cover a compact transcript when a subagent appears", async () => {
		vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
			matches: query.includes("599px") || query.includes("839px"),
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}));
		await renderWorkspace(true);
		await act(async () => document.querySelector<HTMLButtonElement>(".sh-title-btn")?.click());
		await act(async () => document.querySelector<HTMLButtonElement>(".ss-item")?.click());
		await act(async () => {
			client?.applyFrameForTest({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: HEADER,
				state: STATE,
				agents: [
					{
						id: "worker-1",
						displayName: "Worker",
						kind: "sub",
						status: "running",
						hasSessionFile: false,
						createdAt: 1,
						lastActivity: 1,
					} satisfies AgentSnapshot,
				],
				entryCount: 0,
			});
			await Bun.sleep(30);
		});
		expect(client?.getSnapshot().agents).toHaveLength(1);
		expect(document.querySelector(".sh-app")?.getAttribute("data-layout")).toBe("compact");
		expect(document.querySelector(".sh-rail")).toBeNull();
		expect(document.querySelector(".sh-content")?.getAttribute("data-rail")).toBe("false");
	});

	it("never leaves the transcript area blank on a phone surface", async () => {
		// The phone surface always supplies an `emptySlot`: the greeting for a
		// draft, the skeleton while a session hydrates. A blank transcript meant
		// the page had no surface at all — a desktop-shaped layout that renders
		// no empty state — which is what a wide touch browser got before the
		// `hover: none` breakpoint fix.
		await renderWorkspace(true);
		expect(document.querySelector(".sh-app")?.getAttribute("data-surface")).toBe("mobile");
		expect(document.querySelector(".sh-welcome-hint")).not.toBeNull();

		// Enter a session: while it hydrates the skeleton owns the empty area.
		await act(async () => document.querySelector<HTMLButtonElement>(".sh-title-btn")?.click());
		await act(async () => document.querySelector<HTMLButtonElement>(".ss-item")?.click());
		await act(async () => {
			client?.applyFrameForTest({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: HEADER,
				state: STATE,
				agents: [] as AgentSnapshot[],
				entryCount: 0,
			});
			await Bun.sleep(30);
		});
		// One of the two empty states is always present — never nothing. A
		// session that has landed (phase live, no entries yet) shows the
		// greeting; one still hydrating shows the skeleton.
		const empty = document.querySelector(".sh-welcome-hint") ?? document.querySelector(".sh-skeleton");
		expect(empty).not.toBeNull();
		expect(document.querySelector(".tr-empty")).toBeNull();
	});
});
