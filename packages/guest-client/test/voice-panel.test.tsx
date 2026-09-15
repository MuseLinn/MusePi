import { describe, expect, it } from "bun:test";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { VoicePanel } from "../src/components/panels/VoicePanel";
import { GuestClient } from "../src/lib/client";

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

describe("VoicePanel", () => {
	it("renders the speech-test card with both test actions", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		// The long-orphaned speech-test i18n keys finally have a consumer.
		expect(html).toContain("Speech test");
		expect(html).toContain("Play test phrase");
		expect(html).toContain("Test microphone");
	});

	it("shows device-native support status for both engines", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		expect(html).toContain("On-device speech recognition");
		expect(html).toContain("On-device speech synthesis");
		// Test env has no window → both engines report unsupported.
		expect(html).toContain("Not supported on this device");
	});

	it("renders the engine router with all three choices", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		expect(html).toContain("Speech engine");
		expect(html).toContain("Auto");
		expect(html).toContain("Daemon");
	});

	it("renders the Kokoro voice picker with preview buttons", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		expect(html).toContain("Voice");
		expect(html).toContain("Heart (American female)");
		expect(html).toContain("Fable (British male)");
		// openchamber-style per-voice preview.
		expect(html).toContain("Preview: Heart (American female)");
	});

	it("renders the rate slider and dictation language picker", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		expect(html).toContain("Rate");
		expect(html).toContain("×1.0");
		expect(html).toContain("Input language");
	});

	it("renders the auto-read toggle row", () => {
		const html = renderToStaticMarkup(<VoicePanel client={liveClient()} />);
		expect(html).toContain("Auto read aloud");
	});
});
