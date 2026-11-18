import { afterEach, describe, expect, it } from "bun:test";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderBar } from "../src/components/shell/HeaderBar";
import { setLocale } from "../src/i18n/index.js";
import { GuestClient } from "../src/lib/client";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

function state(overrides: Partial<SessionState> = {}): SessionState {
	return { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [], ...overrides };
}

function clientWith(stateOverrides: Partial<SessionState> = {}): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: state(stateOverrides),
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
	onNewSession: () => {},
});

function mockMatchMedia(matches: boolean): void {
	(globalThis as Record<string, unknown>).window = {
		matchMedia: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
	};
}

afterEach(() => {
	setLocale("en-US");
	delete (globalThis as Record<string, unknown>).window;
});

describe("HeaderBar renders reader copy, not wire vocabulary", () => {
	it("labels the phase dot instead of printing the phase id", () => {
		mockMatchMedia(false);
		const html = renderToStaticMarkup(<HeaderBar {...props(clientWith())} />);
		// `welcome` with no entries lands on the live phase.
		expect(html).toContain('title="Connected"');
		expect(html).not.toContain('title="live"');
	});

	it("labels the thinking level with the ladder's own words", () => {
		mockMatchMedia(false);
		const html = renderToStaticMarkup(<HeaderBar {...props(clientWith({ thinkingLevel: "xhigh" }))} />);
		expect(html).toContain("Maximum");
		// The raw rung id must not reach the chip's text node.
		expect(html).not.toContain(">xhigh<");
	});

	it("keeps an unknown thinking level readable rather than relabelling it", () => {
		mockMatchMedia(false);
		const html = renderToStaticMarkup(<HeaderBar {...props(clientWith({ thinkingLevel: "turbo" }))} />);
		expect(html).toContain(">turbo<");
	});

	it("labels participant roles instead of printing host/guest", () => {
		mockMatchMedia(false);
		const html = renderToStaticMarkup(
			<HeaderBar
				{...props(
					clientWith({
						participants: [
							{ name: "Ada", role: "host" },
							{ name: "Bo", role: "guest" },
						],
					}),
				)}
			/>,
		);
		expect(html).toContain("Ada · Computer");
		expect(html).toContain("Bo · Guest");
		expect(html).not.toContain("Ada · host");
		expect(html).not.toContain("Bo · guest");
	});

	it("follows the active locale for the same chip", () => {
		mockMatchMedia(false);
		setLocale("zh-CN");
		const html = renderToStaticMarkup(<HeaderBar {...props(clientWith({ thinkingLevel: "low" }))} />);
		expect(html).toContain("低");
	});
});
