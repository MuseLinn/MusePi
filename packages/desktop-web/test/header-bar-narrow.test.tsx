import { afterEach, describe, expect, it, vi } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import { GuestClient } from "../src/lib/client";
import { HeaderBar } from "../src/components/shell/HeaderBar";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] };

function liveClient(): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: [] as AgentSnapshot[],
		entryCount: 0,
	});
	return client;
}

const props = (client: GuestClient) => ({
	client,
	railOpen: false,
	onToggleRail: () => {},
	onLeave: () => {},
	activePanel: null as "board" | "scheduled" | "files" | "workbench" | null,
	onSelectPanel: () => {},
	currentLink: LINK,
	onSwitchTo: () => {},
	sessions: null,
	focusedSessionId: null,
	onSelectSession: () => {},
});

function mockMatchMedia(matches: boolean): void {
	// bun:test has no DOM — provide a minimal window.matchMedia for the
	// HeaderBar's `typeof window === "undefined"` guard and initial state.
	(globalThis as Record<string, unknown>).window = {
		matchMedia: () => ({
			matches,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
});

describe("HeaderBar narrow-phone panel collapse (≤520px)", () => {
	it("wide layout keeps the four individual panel buttons", () => {
		const client = liveClient();
		mockMatchMedia(false);
		const html = renderToStaticMarkup(<HeaderBar {...props(client)} />);
		// Four panel entries render as separate icon buttons (each with a title).
		expect(html).toContain('title="Board"');
		expect(html).toContain('title="Task Center"');
		expect(html).toContain('title="Files"');
		expect(html).toContain('title="Workbench"');
		// No collapsed menu.
		expect(html).not.toContain("sh-panel-menu-pop");
	});

	it("narrow layout collapses the four panel buttons into one panels menu", () => {
		const client = liveClient();
		mockMatchMedia(true);
		const html = renderToStaticMarkup(<HeaderBar {...props(client)} />);
		// The collapsed trigger is present, and the four wide buttons are gone.
		expect(html).toContain('title="Panels"');
		expect(html).not.toContain('title="Board"');
		expect(html).not.toContain('title="Task Center"');
	});
});
