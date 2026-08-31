import { describe, expect, it, vi } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import { Composer } from "../src/components/shell/Composer";
import { GuestClient } from "../src/lib/client";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] };

function clientWithAsk(request: { title: string; options: string[]; checkedIndices?: number[]; helpText?: string }): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: [] as AgentSnapshot[],
		entryCount: 0,
	});
	client.applyFrameForTest({
		t: "ui-request",
		request: { kind: "select", reqId: 7, ...request, selectionMarker: "checkbox", markableCount: request.options.length },
	});
	return client;
}

describe("multi-select (checkbox) ask — host toggle loop", () => {
	it("toggling an option keeps the dialog mounted and marks it pending (no flash-away)", () => {
		const client = clientWithAsk({ title: "Pick languages", options: ["Rust", "Go"] });
		client.sendUiResponse(7, "Rust");
		const snap = client.getSnapshot();
		// The request stays mounted — the mobile ask UI must not vanish after
		// the first tap (the old behavior: #showNextUiRequest cleared it).
		expect(snap.uiRequest?.reqId).toBe(7);
		expect(snap.uiRequestPending).toBe(true);
	});

	it("a host re-issue with the same title replaces the pending request and clears pending", () => {
		const client = clientWithAsk({ title: "Pick languages", options: ["Rust", "Go"] });
		client.sendUiResponse(7, "Rust");
		// Host answers the toggle with a fresh request: same title, new reqId,
		// updated checked set (Rust now checked).
		client.applyFrameForTest({
			t: "ui-request",
			request: {
				kind: "select",
				reqId: 8,
				title: "Pick languages",
				options: ["Rust", "Go", "Next →", "Chat about this"],
				selectionMarker: "checkbox",
				checkedIndices: [0],
				markableCount: 2,
			},
		});
		const snap = client.getSnapshot();
		expect(snap.uiRequest?.reqId).toBe(8);
		expect(snap.uiRequestPending).toBe(false);
		expect(snap.uiRequest?.kind === "select" && snap.uiRequest.checkedIndices).toEqual([0]);
	});

	it("ui-request-end settles the loop and unmounts the dialog", () => {
		const client = clientWithAsk({ title: "Pick languages", options: ["Rust"] });
		client.sendUiResponse(7, "Rust");
		client.applyFrameForTest({ t: "ui-request-end", reqId: 7 });
		const snap = client.getSnapshot();
		expect(snap.uiRequest).toBeNull();
		expect(snap.uiRequestPending).toBe(false);
	});

	it("renders the multi-select hint and locks options while pending", () => {
		const client = clientWithAsk({ title: "Pick languages", options: ["Rust", "Go"], helpText: "toggle then Next" });
		// Pre-toggle: options enabled, hint visible.
		const before = renderToStaticMarkup(<Composer client={client} />);
		expect(before).toContain("sh-ask-hint");
		expect(before).not.toContain("disabled");
		// After the toggle: the dialog stays rendered, options lock, hint stays.
		client.sendUiResponse(7, "Rust");
		const after = renderToStaticMarkup(<Composer client={client} />);
		expect(after).toContain("sh-ask-hint");
		expect(after).toContain('disabled=""');
	});

	it("a different-title request while pending is queued, not swallowed", () => {
		const client = clientWithAsk({ title: "Pick languages", options: ["Rust"] });
		client.sendUiResponse(7, "Rust");
		client.applyFrameForTest({
			t: "ui-request",
			request: { kind: "select", reqId: 9, title: "Second question", options: ["A"], selectionMarker: "radio" },
		});
		// The pending multi-select stays current; the new question queues.
		expect(client.getSnapshot().uiRequest?.reqId).toBe(7);
		// Settle the multi-select → the queued second question surfaces.
		client.applyFrameForTest({ t: "ui-request-end", reqId: 7 });
		expect(client.getSnapshot().uiRequest?.reqId).toBe(9);
		expect(client.getSnapshot().uiRequestPending).toBe(false);
	});

	it("Next submits the wire 'Next →' literal; Cancel sends an undefined value (guest cancel)", () => {
		// Regression: the ask previously rendered a single button labeled
		// "Cancel" that sent the cancel value — the Next/submit action did
		// not exist on the mobile composer. The two buttons must map to the
		// host's toggle-loop contract: "Next →" ends the loop with the
		// current checked set, an undefined value cancels the ask.
		const sent: { reqId: number; value?: string }[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: { t: string; reqId?: number; value?: string }) => {
			if (frame.t === "ui-response") sent.push({ reqId: frame.reqId as number, value: frame.value });
		});
		try {
			const client = clientWithAsk({ title: "Pick languages", options: ["Rust", "Go"], helpText: "toggle then Next" });
			const html = renderToStaticMarkup(<Composer client={client} />);
			// Both actions render with distinct labels.
			expect(html).toContain(">Next</button>");
			expect(html).toContain(">Cancel</button>");
			// Press the buttons through the handlers they bind: Next submits
			// the literal, Cancel sends no value.
			client.sendUiResponse(7, "Next →");
			client.sendUiResponse(8);
			expect(sent).toEqual([
				{ reqId: 7, value: "Next →" },
				{ reqId: 8, value: undefined },
			]);
		} finally {
			sendSpy.mockRestore();
		}
	});
});
